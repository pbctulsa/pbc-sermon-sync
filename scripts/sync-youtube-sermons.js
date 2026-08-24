import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { XMLParser } from "fast-xml-parser";

const YOUTUBE_API_URL = "https://www.googleapis.com/youtube/v3/playlistItems";
const PLANNING_CENTER_API_URL = "https://api.planningcenteronline.com/publishing/v2";
const PLANNING_CENTER_UPLOAD_URL = "https://upload.planningcenteronline.com/v2/files";
const execFileAsync = promisify(execFile);

const env = {
  planningCenterClientId: process.env.PC_CLIENTID,
  planningCenterSecret: process.env.PC_SECRET,
  youtubeApiKey: process.env.YOUTUBE_API_KEY,
  youtubePlaylistId: process.env.YOUTUBE_PLAYLIST_ID,
  podcastSourceFeedUrl: process.env.PODCAST_SOURCE_FEED_URL || null,
  planningCenterChannelId: process.env.PC_SERMON_CHANNEL_ID,
  syncAfterVideoId: process.env.SYNC_AFTER_VIDEO_ID || null,
  syncNotBefore: process.env.SYNC_NOT_BEFORE || null,
  dryRun: isTruthy(process.env.DRY_RUN),
  publishEpisodes: isTruthy(process.env.PUBLISH_EPISODES),
  syncPodcastAudio: isTruthy(process.env.SYNC_PODCAST_AUDIO),
  audioBackfillAllPlaylist: isTruthy(process.env.AUDIO_BACKFILL_ALL_PLAYLIST),
  forceThumbnailBackfill: isTruthy(process.env.FORCE_THUMBNAIL_BACKFILL),
  thumbnailEpisodeIdMin: process.env.THUMBNAIL_EPISODE_ID_MIN
    ? Number.parseInt(process.env.THUMBNAIL_EPISODE_ID_MIN, 10)
    : null,
  maxEpisodesPerRun: Number.parseInt(process.env.MAX_EPISODES_PER_RUN || "10", 10),
  maxPodcastAudioPerRun: Number.parseInt(process.env.MAX_PODCAST_AUDIO_PER_RUN || "5", 10),
  excludedTitles: new Set(
    (process.env.EXCLUDED_TITLES || "Sunday Service")
      .split(",")
      .map((title) => title.trim().toLowerCase())
      .filter(Boolean),
  ),
};

if (isMainModule()) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

async function main() {
  validateConfig();

  const [channel, playlistItems, existingEpisodes, podcastSourceEpisodes] = await Promise.all([
    fetchPlanningCenterChannel(),
    fetchYouTubePlaylistItems(),
    fetchPlanningCenterEpisodes(),
    env.syncPodcastAudio && env.podcastSourceFeedUrl ? fetchPodcastSourceEpisodes(env.podcastSourceFeedUrl) : [],
  ]);

  const normalizedVideos = playlistItems
    .map(normalizeYouTubeItem)
    .filter(Boolean)
    .filter((video) => !env.excludedTitles.has(video.title.toLowerCase()));
  const videos = filterVideosForSync(normalizedVideos, env.syncAfterVideoId, env.syncNotBefore);
  const missingVideos = findMissingVideos(videos, existingEpisodes);
  const thumbnailUpdates = findThumbnailUpdates(
    videos,
    existingEpisodes,
    env.forceThumbnailBackfill,
    env.thumbnailEpisodeIdMin,
  );
  const videoUrlUpdates = findOnDemandVideoUrlUpdates(videos, existingEpisodes);
  const allPodcastAudioUpdates = env.syncPodcastAudio
    ? findPodcastAudioUpdates(env.audioBackfillAllPlaylist ? normalizedVideos : videos, existingEpisodes)
    : [];
  const podcastAudioUpdates = allPodcastAudioUpdates.slice(0, env.maxPodcastAudioPerRun);

  console.log(`Checked ${playlistItems.length} YouTube playlist item(s).`);
  console.log(`Found ${existingEpisodes.length} episode(s) in Planning Center channel ${channel.attributes?.name || channel.id}.`);

  if (env.syncPodcastAudio && !channel.attributes?.enable_audio) {
    if (env.dryRun) {
      console.log("[dry run] Would enable audio on the Planning Center sermon channel.");
    } else {
      await enablePlanningCenterChannelAudio(channel.id);
      console.log("Enabled audio on the Planning Center sermon channel.");
    }
  }

  if (env.syncPodcastAudio) {
    if (podcastSourceEpisodes.length > 0) {
      console.log(`Loaded ${podcastSourceEpisodes.length} existing podcast episode(s) as migration audio sources.`);
    }
    console.log(
      channel.attributes?.podcast_feed_url
        ? `Planning Center podcast feed: ${channel.attributes.podcast_feed_url}`
        : "Planning Center podcast feed settings still need to be completed before migrating from Buzzsprout.",
    );
  }

  if (env.syncAfterVideoId) {
    console.log(`Only syncing videos added to the playlist after YouTube video ${env.syncAfterVideoId}.`);
  } else if (env.syncNotBefore) {
    console.log(`Only syncing videos added to the playlist on or after ${new Date(env.syncNotBefore).toISOString()}.`);
  }

  if (
    missingVideos.length === 0 &&
    thumbnailUpdates.length === 0 &&
    videoUrlUpdates.length === 0 &&
    podcastAudioUpdates.length === 0
  ) {
    console.log("Planning Center is already up to date.");
    return;
  }

  if (missingVideos.length > 0) console.log(`Found ${missingVideos.length} new sermon video(s).`);
  if (thumbnailUpdates.length > 0) console.log(`Found ${thumbnailUpdates.length} episode thumbnail(s) to add.`);
  if (videoUrlUpdates.length > 0) console.log(`Found ${videoUrlUpdates.length} on-demand video URL(s) to add.`);
  if (allPodcastAudioUpdates.length > 0) {
    console.log(
      `Found ${allPodcastAudioUpdates.length} episode podcast audio file(s) to add; ` +
        `processing up to ${env.maxPodcastAudioPerRun} this run.`,
    );
  }

  const totalChanges = missingVideos.length + thumbnailUpdates.length + videoUrlUpdates.length + podcastAudioUpdates.length;
  if (!env.dryRun && totalChanges > env.maxEpisodesPerRun) {
    throw new Error(
      `Refusing to make ${totalChanges} episode changes in one run. ` +
        `Review with DRY_RUN=true, adjust the sync boundary, or raise MAX_EPISODES_PER_RUN (currently ${env.maxEpisodesPerRun}).`,
    );
  }

  for (const { video, episode } of thumbnailUpdates) {
    if (env.dryRun) {
      console.log(`[dry run] Would add YouTube thumbnail to episode ${episode.id}: ${video.title}`);
      continue;
    }

    const uploadId = await uploadYouTubeThumbnail(video);
    await updatePlanningCenterEpisodeArt(episode.id, uploadId);
    console.log(`Added YouTube thumbnail to episode ${episode.id}: ${video.title}`);
  }

  for (const { video, episode } of videoUrlUpdates) {
    if (env.dryRun) {
      console.log(`[dry run] Would add on-demand video URL to episode ${episode.id}: ${video.title}`);
      continue;
    }

    await updatePlanningCenterEpisodeOnDemandUrl(episode.id, video.url);
    console.log(`Added on-demand video URL to episode ${episode.id}: ${video.title}`);
  }

  for (const { video, episode } of podcastAudioUpdates) {
    if (env.dryRun) {
      console.log(`[dry run] Would add podcast audio to episode ${episode.id}: ${video.title}`);
      continue;
    }

    const sourceAudioUrl = findPodcastSourceAudioUrl(video.title, podcastSourceEpisodes);
    const uploadId = sourceAudioUrl
      ? await uploadRemotePodcastAudio(video, sourceAudioUrl)
      : await uploadYouTubeAudio(video);
    await updatePlanningCenterEpisodeAudio(episode.id, uploadId);
    console.log(`Added podcast audio to episode ${episode.id}: ${video.title}`);
  }

  for (const video of missingVideos) {
    if (env.dryRun) {
      console.log(`[dry run] Would create: ${video.title} (${video.url})`);
      continue;
    }

    const uploadId = video.thumbnailUrl ? await uploadYouTubeThumbnail(video) : null;
    const audioUploadId = env.syncPodcastAudio ? await uploadYouTubeAudio(video) : null;
    const episode = await createPlanningCenterEpisode(video, uploadId, audioUploadId);
    const status = env.publishEpisodes ? "published" : "draft";
    console.log(`Created ${status} episode ${episode.id}: ${video.title}`);
  }
}

async function fetchPodcastSourceEpisodes(feedUrl) {
  const response = await fetch(feedUrl);
  if (!response.ok) throw new Error(`Podcast source feed download failed (${response.status}).`);
  return parsePodcastFeed(await response.text());
}

async function uploadRemotePodcastAudio(video, audioUrl) {
  const audioResponse = await fetch(audioUrl, {
    headers: {
      "User-Agent": "AppleCoreMedia/1.0.0 (iPhone; CPU iPhone OS like Mac OS X)",
      Referer: env.podcastSourceFeedUrl || "https://rss.buzzsprout.com/",
    },
  });
  if (!audioResponse.ok) {
    throw new Error(`Podcast audio download failed for ${video.id} (${audioResponse.status}).`);
  }

  const audio = await audioResponse.arrayBuffer();
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/mpeg" }), `${video.id}.mp3`);

  const response = await planningCenterRequest(PLANNING_CENTER_UPLOAD_URL, {
    method: "POST",
    body: form,
  });
  const body = await parseResponse(response, "Planning Center migrated podcast audio upload");
  const uploadId = body.data?.[0]?.id;
  if (!uploadId) throw new Error(`Planning Center did not return an audio upload ID for ${video.id}.`);
  return uploadId;
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

  if (!Number.isInteger(env.maxPodcastAudioPerRun) || env.maxPodcastAudioPerRun < 1) {
    throw new Error("MAX_PODCAST_AUDIO_PER_RUN must be a positive integer.");
  }

  if (env.thumbnailEpisodeIdMin !== null && !Number.isInteger(env.thumbnailEpisodeIdMin)) {
    throw new Error("THUMBNAIL_EPISODE_ID_MIN must be an integer.");
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

async function enablePlanningCenterChannelAudio(channelId) {
  const response = await planningCenterRequest(`/channels/${channelId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/vnd.api+json" },
    body: JSON.stringify({
      data: {
        type: "Channel",
        id: String(channelId),
        attributes: { enable_audio: true },
      },
    }),
  });
  await parseResponse(response, "Planning Center channel audio update");
}

async function createPlanningCenterEpisode(video, uploadId, audioUploadId) {
  const response = await planningCenterRequest("/episodes", {
    method: "POST",
    headers: { "Content-Type": "application/vnd.api+json" },
    body: JSON.stringify(
      buildEpisodePayload(video, env.planningCenterChannelId, env.publishEpisodes, uploadId, audioUploadId),
    ),
  });
  const body = await parseResponse(response, "Planning Center episode creation");
  return body.data;
}

async function uploadYouTubeAudio(video) {
  const downloadDirectory = await mkdtemp(join(tmpdir(), "pbc-sermon-audio-"));

  try {
    const outputTemplate = join(downloadDirectory, `${video.id}.%(ext)s`);
    await execFileAsync(
      "yt-dlp",
      [
        "--no-playlist",
        "--no-progress",
        "--extract-audio",
        "--audio-format",
        "mp3",
        "--audio-quality",
        "5",
        "--js-runtimes",
        "node",
        "--remote-components",
        "ejs:github",
        "--output",
        outputTemplate,
        video.url,
      ],
      { maxBuffer: 10 * 1024 * 1024 },
    );

    const audioFilename = (await readdir(downloadDirectory)).find((filename) => filename.endsWith(".mp3"));
    if (!audioFilename) throw new Error(`yt-dlp did not produce an MP3 file for ${video.id}.`);

    const audio = await readFile(join(downloadDirectory, audioFilename));
    const form = new FormData();
    form.append("file", new Blob([audio], { type: "audio/mpeg" }), `${video.id}.mp3`);

    const response = await planningCenterRequest(PLANNING_CENTER_UPLOAD_URL, {
      method: "POST",
      body: form,
    });
    const body = await parseResponse(response, "Planning Center sermon audio upload");
    const uploadId = body.data?.[0]?.id;
    if (!uploadId) throw new Error(`Planning Center did not return an audio upload ID for ${video.id}.`);
    return uploadId;
  } finally {
    await rm(downloadDirectory, { recursive: true, force: true });
  }
}

async function uploadYouTubeThumbnail(video) {
  const thumbnailResponse = await fetch(video.thumbnailUrl);
  if (!thumbnailResponse.ok) {
    throw new Error(`YouTube thumbnail download failed for ${video.id} (${thumbnailResponse.status}).`);
  }

  const image = await thumbnailResponse.blob();
  const form = new FormData();
  form.append("file", image, `${video.id}.${image.type === "image/png" ? "png" : "jpg"}`);

  const response = await planningCenterRequest(PLANNING_CENTER_UPLOAD_URL, {
    method: "POST",
    body: form,
  });
  const body = await parseResponse(response, "Planning Center thumbnail upload");
  const uploadId = body.data?.[0]?.id;
  if (!uploadId) throw new Error(`Planning Center did not return an upload ID for ${video.id}.`);
  return uploadId;
}

async function updatePlanningCenterEpisodeArt(episodeId, uploadId) {
  const response = await planningCenterRequest(`/episodes/${episodeId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/vnd.api+json" },
    body: JSON.stringify({
      data: {
        type: "Episode",
        id: String(episodeId),
        attributes: { art: uploadId },
      },
    }),
  });
  await parseResponse(response, "Planning Center episode thumbnail update");
}

async function updatePlanningCenterEpisodeOnDemandUrl(episodeId, videoUrl) {
  const response = await planningCenterRequest(`/episodes/${episodeId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/vnd.api+json" },
    body: JSON.stringify({
      data: {
        type: "Episode",
        id: String(episodeId),
        attributes: { library_video_url: videoUrl },
      },
    }),
  });
  await parseResponse(response, "Planning Center on-demand video URL update");
}

async function updatePlanningCenterEpisodeAudio(episodeId, uploadId) {
  const response = await planningCenterRequest(`/episodes/${episodeId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/vnd.api+json" },
    body: JSON.stringify({
      data: {
        type: "Episode",
        id: String(episodeId),
        attributes: { sermon_audio: uploadId },
      },
    }),
  });
  await parseResponse(response, "Planning Center episode sermon audio update");
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

  const thumbnails = item.snippet?.thumbnails || {};
  const thumbnailUrl = ["maxres", "standard", "high", "medium", "default"]
    .map((size) => thumbnails[size]?.url)
    .find(Boolean) || null;

  return {
    id: videoId,
    title,
    description: item.snippet?.description?.trim() || "",
    addedToPlaylistAt: item.snippet?.publishedAt || null,
    publishedAt: item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt || null,
    thumbnailUrl,
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

export function findThumbnailUpdates(videos, episodes, force = false, episodeIdMin = null) {
  const videoById = new Map(videos.map((video) => [video.id, video]));

  return episodes.flatMap((episode) => {
    const attributes = episode.attributes || {};
    const videoId = [attributes.video_url, attributes.library_video_url]
      .map(extractYouTubeVideoId)
      .find(Boolean);
    const video = videoById.get(videoId);

    if (episodeIdMin !== null && Number(episode.id) < episodeIdMin) return [];
    if (!video?.thumbnailUrl || (!force && hasEpisodeArt(attributes.art))) return [];
    return [{ video, episode }];
  });
}

export function findOnDemandVideoUrlUpdates(videos, episodes) {
  const videoById = new Map(videos.map((video) => [video.id, video]));

  return episodes.flatMap((episode) => {
    const attributes = episode.attributes || {};
    if (extractYouTubeVideoId(attributes.library_video_url)) return [];

    const videoId = extractYouTubeVideoId(attributes.video_url);
    const video = videoById.get(videoId);
    return video ? [{ video, episode }] : [];
  });
}

export function findPodcastAudioUpdates(videos, episodes) {
  const videoById = new Map(videos.map((video) => [video.id, video]));

  return episodes.flatMap((episode) => {
    const attributes = episode.attributes || {};
    if (hasEpisodeAudio(attributes)) return [];

    const videoId = [attributes.library_video_url, attributes.video_url]
      .map(extractYouTubeVideoId)
      .find(Boolean);
    const video = videoById.get(videoId);
    return video ? [{ video, episode }] : [];
  });
}

export function parsePodcastFeed(xml) {
  const parser = new XMLParser({ ignoreAttributes: false, processEntities: false });
  const parsed = parser.parse(xml);
  const items = parsed?.rss?.channel?.item;
  const list = Array.isArray(items) ? items : items ? [items] : [];

  return list.flatMap((item) => {
    const title = String(item.title || item["itunes:title"] || "").trim();
    const audioUrl = item.enclosure?.["@_url"];
    return title && audioUrl ? [{ title, audioUrl }] : [];
  });
}

export function findPodcastSourceAudioUrl(title, podcastEpisodes) {
  const wanted = normalizeTitleForMatching(title);
  const exact = podcastEpisodes.find((episode) => normalizeTitleForMatching(episode.title) === wanted);
  if (exact) return exact.audioUrl;

  const closest = podcastEpisodes
    .map((episode) => ({ episode, distance: levenshteinDistance(wanted, normalizeTitleForMatching(episode.title)) }))
    .sort((left, right) => left.distance - right.distance)[0];
  return closest && closest.distance <= 2 ? closest.episode.audioUrl : null;
}

function normalizeTitleForMatching(title) {
  return String(title || "")
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function levenshteinDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(previous[rightIndex] + 1, current[rightIndex - 1] + 1, substitution);
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length];
}

export function hasEpisodeAudio(attributes = {}) {
  if (typeof attributes.library_audio_url === "string" && attributes.library_audio_url.length > 0) return true;
  const audio = attributes.sermon_audio;
  if (!audio) return false;
  if (typeof audio === "string") return audio.length > 0;
  if (typeof audio !== "object") return false;
  return [audio.url, audio.filename, audio.name, audio.signed_identifier, audio.id].some(
    (value) => typeof value === "string" && value.length > 0,
  ) || (typeof audio.byte_size === "number" && audio.byte_size > 0);
}

export function hasEpisodeArt(art) {
  if (!art) return false;
  if (typeof art === "string") return art.length > 0;
  if (typeof art !== "object") return false;
  return Object.values(art).some(Boolean);
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

export function buildEpisodePayload(video, channelId, publish, uploadId = null, audioUploadId = null) {
  return {
    data: {
      type: "Episode",
      attributes: {
        title: video.title,
        description: video.description,
        stream_type: "prerecorded",
        library_video_url: video.url,
        published_to_library_at: publish ? video.publishedAt || new Date().toISOString() : null,
        ...(uploadId ? { art: uploadId } : {}),
        ...(audioUploadId ? { sermon_audio: audioUploadId } : {}),
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
