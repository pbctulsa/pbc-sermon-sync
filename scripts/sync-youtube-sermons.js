import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const YOUTUBE_API_URL = "https://www.googleapis.com/youtube/v3/playlistItems";
const PLANNING_CENTER_API_URL = "https://api.planningcenteronline.com/publishing/v2";

const env = {
  planningCenterClientId: process.env.PC_CLIENTID,
  planningCenterSecret: process.env.PC_SECRET,
  youtubeApiKey: process.env.YOUTUBE_API_KEY,
  youtubePlaylistId: process.env.YOUTUBE_PLAYLIST_ID,
  planningCenterChannelId: process.env.PC_SERMON_CHANNEL_ID,
  syncAfterVideoId: process.env.SYNC_AFTER_VIDEO_ID || null,
  syncNotBefore: process.env.SYNC_NOT_BEFORE || null,
  dryRun: isTruthy(process.env.DRY_RUN),
  publishEpisodes: isTruthy(process.env.PUBLISH_EPISODES),
  maxEpisodesPerRun: Number.parseInt(process.env.MAX_EPISODES_PER_RUN || "10", 10),
};

if (isMainModule()) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

async function main() {
  validateConfig();

  const [channel, playlistItems, existingEpisodes] = await Promise.all([
    fetchPlanningCenterChannel(),
    fetchYouTubePlaylistItems(),
    fetchPlanningCenterEpisodes(),
  ]);

  const normalizedVideos = playlistItems
    .map(normalizeYouTubeItem)
    .filter(Boolean);
  const videos = filterVideosForSync(normalizedVideos, env.syncAfterVideoId, env.syncNotBefore);
  const missingVideos = findMissingVideos(videos, existingEpisodes);

  console.log(`Checked ${playlistItems.length} YouTube playlist item(s).`);
  console.log(`Found ${existingEpisodes.length} episode(s) in Planning Center channel ${channel.attributes?.name || channel.id}.`);

  if (env.syncAfterVideoId) {
    console.log(`Only syncing videos added to the playlist after YouTube video ${env.syncAfterVideoId}.`);
  } else if (env.syncNotBefore) {
    console.log(`Only syncing videos added to the playlist on or after ${new Date(env.syncNotBefore).toISOString()}.`);
  }

  if (missingVideos.length === 0) {
    console.log("Planning Center is already up to date.");
    return;
  }

  console.log(`Found ${missingVideos.length} new sermon video(s).`);

  if (!env.dryRun && missingVideos.length > env.maxEpisodesPerRun) {
    throw new Error(
      `Refusing to create ${missingVideos.length} episodes in one run. ` +
        `Review with DRY_RUN=true, adjust the sync boundary, or raise MAX_EPISODES_PER_RUN (currently ${env.maxEpisodesPerRun}).`,
    );
  }

  for (const video of missingVideos) {
    if (env.dryRun) {
      console.log(`[dry run] Would create: ${video.title} (${video.url})`);
      continue;
    }

    const episode = await createPlanningCenterEpisode(video);
    const status = env.publishEpisodes ? "published" : "draft";
    console.log(`Created ${status} episode ${episode.id}: ${video.title}`);
  }
}

function validateConfig() {
  const required = {
    PC_CLIENTID: env.planningCenterClientId,
    PC_SECRET: env.planningCenterSecret,
    YOUTUBE_API_KEY: env.youtubeApiKey,
    YOUTUBE_PLAYLIST_ID: env.youtubePlaylistId,
    PC_SERMON_CHANNEL_ID: env.planningCenterChannelId,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }

  if (env.syncNotBefore && Number.isNaN(Date.parse(env.syncNotBefore))) {
    throw new Error("SYNC_NOT_BEFORE must be a valid date or date-time.");
  }

  if (!Number.isInteger(env.maxEpisodesPerRun) || env.maxEpisodesPerRun < 1) {
    throw new Error("MAX_EPISODES_PER_RUN must be a positive integer.");
  }
}

async function fetchYouTubePlaylistItems() {
  const items = [];
  let pageToken = null;

  do {
    const url = new URL(YOUTUBE_API_URL);
    url.searchParams.set("part", "snippet,contentDetails,status");
    url.searchParams.set("playlistId", env.youtubePlaylistId);
    url.searchParams.set("maxResults", "50");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const response = await fetch(url, {
      headers: { "X-Goog-Api-Key": env.youtubeApiKey },
    });
    const page = await parseResponse(response, "YouTube");
    items.push(...(page.items || []));
    pageToken = page.nextPageToken || null;
  } while (pageToken);

  return items;
}

async function fetchPlanningCenterChannel() {
  const response = await planningCenterRequest(`/channels/${env.planningCenterChannelId}`);
  const body = await parseResponse(response, "Planning Center channel");
  return body.data;
}

async function fetchPlanningCenterEpisodes() {
  const episodes = [];
  let nextUrl = `${PLANNING_CENTER_API_URL}/channels/${env.planningCenterChannelId}/episodes?per_page=100`;

  while (nextUrl) {
    const response = await planningCenterRequest(nextUrl);
    const page = await parseResponse(response, "Planning Center episodes");
    episodes.push(...(page.data || []));
    nextUrl = page.links?.next || null;
  }

  return episodes;
}

async function createPlanningCenterEpisode(video) {
  const response = await planningCenterRequest("/episodes", {
    method: "POST",
    headers: { "Content-Type": "application/vnd.api+json" },
    body: JSON.stringify(buildEpisodePayload(video, env.planningCenterChannelId, env.publishEpisodes)),
  });
  const body = await parseResponse(response, "Planning Center episode creation");
  return body.data;
}

function planningCenterRequest(pathOrUrl, options = {}) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${PLANNING_CENTER_API_URL}${pathOrUrl}`;
  const authorization = Buffer.from(`${env.planningCenterClientId}:${env.planningCenterSecret}`).toString("base64");

  return fetch(url, {
    ...options,
    headers: {
      Authorization: `Basic ${authorization}`,
      Accept: "application/json",
      ...options.headers,
    },
  });
}

async function parseResponse(response, label) {
  const text = await response.text();
  let body = {};

  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`${label} returned an invalid response (${response.status}): ${text}`);
    }
  }

  if (!response.ok) {
    throw new Error(`${label} request failed (${response.status}): ${JSON.stringify(body)}`);
  }

  return body;
}

export function normalizeYouTubeItem(item) {
  const videoId = item.contentDetails?.videoId || item.snippet?.resourceId?.videoId;
  const title = item.snippet?.title?.trim();
  const unavailable = ["Private video", "Deleted video"].includes(title) || item.status?.privacyStatus === "private";

  if (!videoId || !title || unavailable) return null;

  return {
    id: videoId,
    title,
    description: item.snippet?.description?.trim() || "",
    addedToPlaylistAt: item.snippet?.publishedAt || null,
    publishedAt: item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt || null,
    url: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

export function filterVideosForSync(videos, syncAfterVideoId, syncNotBefore) {
  if (syncAfterVideoId) {
    const boundary = videos.find((video) => video.id === syncAfterVideoId);
    if (!boundary) {
      throw new Error(`SYNC_AFTER_VIDEO_ID ${syncAfterVideoId} was not found in the YouTube playlist.`);
    }
    if (!boundary.addedToPlaylistAt) {
      throw new Error(`YouTube did not provide a playlist-added date for boundary video ${syncAfterVideoId}.`);
    }

    return videos.filter(
      (video) => video.addedToPlaylistAt && Date.parse(video.addedToPlaylistAt) > Date.parse(boundary.addedToPlaylistAt),
    );
  }

  return videos.filter((video) => isOnOrAfterCutoff(video.addedToPlaylistAt, syncNotBefore));
}

export function findMissingVideos(videos, episodes) {
  const existingVideoIds = new Set(
    episodes.flatMap((episode) => {
      const attributes = episode.attributes || {};
      return [attributes.video_url, attributes.library_video_url]
        .map(extractYouTubeVideoId)
        .filter(Boolean);
    }),
  );

  return videos
    .filter((video) => !existingVideoIds.has(video.id))
    .sort((left, right) => new Date(left.addedToPlaylistAt || 0) - new Date(right.addedToPlaylistAt || 0));
}

export function extractYouTubeVideoId(value) {
  if (!value || typeof value !== "string") return null;

  try {
    const url = new URL(value);
    if (url.hostname === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] || null;
    if (url.hostname.endsWith("youtube.com")) {
      return url.searchParams.get("v") || url.pathname.match(/^\/(?:embed|shorts|live)\/([^/?]+)/)?.[1] || null;
    }
  } catch {
    return value.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/))([A-Za-z0-9_-]{6,})/)?.[1] || null;
  }

  return null;
}

export function buildEpisodePayload(video, channelId, publish) {
  return {
    data: {
      type: "Episode",
      attributes: {
        title: video.title,
        description: video.description,
        stream_type: "prerecorded",
        video_url: video.url,
        published_to_library_at: publish ? video.publishedAt || new Date().toISOString() : null,
      },
      relationships: {
        channel: {
          data: { type: "Channel", id: String(channelId) },
        },
      },
    },
  };
}

function isOnOrAfterCutoff(value, cutoff) {
  if (!cutoff) return true;
  if (!value) return false;
  return Date.parse(value) >= Date.parse(cutoff);
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function isMainModule() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}
