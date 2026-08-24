import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEpisodePayload,
  extractYouTubeVideoId,
  filterVideosForSync,
  findMissingVideos,
  normalizeYouTubeItem,
} from "./sync-youtube-sermons.js";

test("extractYouTubeVideoId handles common YouTube URLs", () => {
  assert.equal(extractYouTubeVideoId("https://www.youtube.com/watch?v=abc_123-x"), "abc_123-x");
  assert.equal(extractYouTubeVideoId("https://youtu.be/abc_123-x"), "abc_123-x");
  assert.equal(extractYouTubeVideoId("https://www.youtube.com/live/abc_123-x?feature=share"), "abc_123-x");
  assert.equal(extractYouTubeVideoId("https://example.com/video"), null);
});

test("normalizeYouTubeItem skips unavailable videos", () => {
  assert.equal(normalizeYouTubeItem({ snippet: { title: "Private video" }, contentDetails: { videoId: "private" } }), null);
  assert.deepEqual(
    normalizeYouTubeItem({
      snippet: { title: " Sunday Sermon ", description: " Message ", publishedAt: "2026-08-23T12:00:00Z" },
      contentDetails: { videoId: "video123" },
      status: { privacyStatus: "public" },
    }),
    {
      id: "video123",
      title: "Sunday Sermon",
      description: "Message",
      addedToPlaylistAt: "2026-08-23T12:00:00Z",
      publishedAt: "2026-08-23T12:00:00Z",
      url: "https://www.youtube.com/watch?v=video123",
    },
  );
});

test("filterVideosForSync selects videos added after the boundary video", () => {
  const videos = [
    { id: "newest", addedToPlaylistAt: "2026-08-23T00:00:00Z" },
    { id: "boundary", addedToPlaylistAt: "2026-08-10T00:00:00Z" },
    { id: "older", addedToPlaylistAt: "2026-08-03T00:00:00Z" },
  ];

  assert.deepEqual(filterVideosForSync(videos, "boundary", null), [videos[0]]);
});

test("findMissingVideos deduplicates against both Planning Center video fields", () => {
  const videos = [
    { id: "new-video", addedToPlaylistAt: "2026-08-24T00:00:00Z" },
    { id: "existing-one", addedToPlaylistAt: "2026-08-22T00:00:00Z" },
    { id: "existing-two", addedToPlaylistAt: "2026-08-23T00:00:00Z" },
  ];
  const episodes = [
    { attributes: { video_url: "https://youtube.com/watch?v=existing-one" } },
    { attributes: { library_video_url: "https://youtu.be/existing-two" } },
  ];

  assert.deepEqual(findMissingVideos(videos, episodes), [videos[0]]);
});

test("buildEpisodePayload creates a draft unless publishing is enabled", () => {
  const video = {
    title: "A Sermon",
    description: "Description",
    url: "https://youtu.be/video123",
    publishedAt: "2026-08-23T12:00:00Z",
  };
  const payload = buildEpisodePayload(video, "23566", false);

  assert.equal(payload.data.type, "Episode");
  assert.equal(payload.data.attributes.published_to_library_at, null);
  assert.equal(payload.data.attributes.stream_type, "prerecorded");
  assert.deepEqual(payload.data.relationships.channel.data, { type: "Channel", id: "23566" });

  const publishedPayload = buildEpisodePayload(video, "23566", true);
  assert.equal(publishedPayload.data.attributes.published_to_library_at, "2026-08-23T12:00:00Z");
});
