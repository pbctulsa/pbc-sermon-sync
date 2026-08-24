# PBC Sermon Sync

Automatically creates Planning Center sermon episodes from new videos added to Peniel Baptist Church's YouTube sermon playlist.

## Configuration

- YouTube playlist: [PBC Sermons](https://youtube.com/playlist?list=PL55zozglajy_Nw-rQ-ydZeRjn1kyKnj8z)
- Planning Center channel: [Sunday Sermons](https://pbctulsa.churchcenter.com/channels/23566)
- Schedule: daily at 14:00 UTC (9:00 AM Central during daylight saving time and 8:00 AM Central during standard time)
- Scheduled behavior: create draft episodes for staff review
- Start date: only videos added to the playlist on or after August 23, 2026

The sync copies each video's title, description, and YouTube URL. It matches existing episodes by YouTube video ID, making repeated runs safe.

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
3. Leave `publish` set to `false`.
4. Review the workflow log showing what would be created.
5. Run it again with `dry_run` set to `false` to create drafts.
6. After confirming the draft looks correct in Planning Center, add the `SERMON_SYNC_ENABLED` repository variable with a value of `true`.

Set `publish` to `true` only when new episodes should immediately appear in Church Center.

The workflow refuses to create more than 10 episodes in one run. Change the start date or `MAX_EPISODES_PER_RUN` deliberately for a larger historical import.

## Local Preview

```bash
PC_CLIENTID=... \
PC_SECRET=... \
YOUTUBE_API_KEY=... \
YOUTUBE_PLAYLIST_ID=PL55zozglajy_Nw-rQ-ydZeRjn1kyKnj8z \
PC_SERMON_CHANNEL_ID=23566 \
SYNC_NOT_BEFORE=2026-08-23 \
DRY_RUN=true \
npm run sync
```

## Development

```bash
npm test
npm run check
```
