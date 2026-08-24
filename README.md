# PBC Sermon Sync

Automatically creates Planning Center sermon episodes from new videos added to Peniel Baptist Church's YouTube sermon playlist.

## Configuration

- YouTube playlist: [PBC Sermons](https://youtube.com/playlist?list=PL55zozglajy_Nw-rQ-ydZeRjn1kyKnj8z)
- Planning Center channel: [Sunday Sermons](https://pbctulsa.churchcenter.com/channels/23566)
- Schedule: daily at 14:00 UTC (9:00 AM Central during daylight saving time and 8:00 AM Central during standard time)
- Scheduled behavior: publish new episodes to Church Center
- Starting point: only videos added to the playlist after YouTube video `uZGwiTyVMUU`

The sync copies each video's title, description, YouTube URL, publication date, and thumbnail. Planning Center requires artwork to be uploaded first, so the workflow downloads each YouTube thumbnail and stores it as the episode artwork. It matches existing episodes by YouTube video ID, making repeated runs safe.

Videos titled exactly `Sunday Service` are excluded from synchronization.

## GitHub Secrets

Add these secrets under **Settings → Secrets and variables → Actions**:

- `PC_CLIENTID`: Planning Center Personal Access Token application ID
- `PC_SECRET`: Planning Center Personal Access Token secret
- `YOUTUBE_API_KEY`: Google Cloud API key with YouTube Data API v3 enabled

The Planning Center user associated with the token must have access to Publishing.

Scheduled runs remain disabled until testing is complete. To enable them, create this repository variable:

- `SERMON_SYNC_ENABLED`: set to `true`

## Safe First Run

1. Open **Actions → YouTube Sermon Sync → Run workflow**.
2. Leave `dry_run` set to `true`.
3. Set `publish` to `true` (dry-run mode still prevents changes).
4. Leave `max_episodes_per_run` at `10` for normal runs; increase it deliberately for the initial backfill.
5. Review the workflow log showing what would be created.
6. Run it again with `dry_run` set to `false` and `publish` set to `true` to publish the missing episodes.
7. After confirming they look correct in Planning Center, add the `SERMON_SYNC_ENABLED` repository variable with a value of `true`.

Set `publish` to `true` only when new episodes should immediately appear in Church Center.

The workflow refuses to create more than 10 episodes in one run. Change the boundary video or `MAX_EPISODES_PER_RUN` deliberately for a larger historical import.

## Local Preview

```bash
PC_CLIENTID=... \
PC_SECRET=... \
YOUTUBE_API_KEY=... \
YOUTUBE_PLAYLIST_ID=PL55zozglajy_Nw-rQ-ydZeRjn1kyKnj8z \
PC_SERMON_CHANNEL_ID=23566 \
SYNC_AFTER_VIDEO_ID=uZGwiTyVMUU \
DRY_RUN=true \
npm run sync
```

## Development

```bash
npm test
npm run check
```
