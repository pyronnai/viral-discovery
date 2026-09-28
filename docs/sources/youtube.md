# Source: YouTube

_Verified 2026-09-28; search/channel methods verified 2026-09-29. Adapter status:
**implemented** (`packages/adapters/youtube`, adapter id `youtube`)._

Primary references (all read 2026-09-28):

- `videos.list` — https://developers.google.com/youtube/v3/docs/videos/list (page updated 2026-09-14)
- `videos.batchGetStats` — https://developers.google.com/youtube/v3/docs/videos/batchGetStats (updated 2026-09-14)
- Video resource — https://developers.google.com/youtube/v3/docs/videos (updated 2026-09-16)
- Revision history — https://developers.google.com/youtube/v3/revision_history (updated 2026-09-14)
- Quota and compliance audits — https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits (read in Phase 1, same day)
- `search.list` — https://developers.google.com/youtube/v3/docs/search/list (updated 2026-09-14, read 2026-09-29)
- `playlistItems.list` — https://developers.google.com/youtube/v3/docs/playlistItems/list (updated 2026-09-14)
- `channels.list` / channel resource — https://developers.google.com/youtube/v3/docs/channels (updated 2026-09-16)

## VERIFIED CURRENT BEHAVIOR

- **`videos.list`** costs **1 unit** per call. Filters: `chart=mostPopular`, `id`, or
  `myRating`. `regionCode` is an ISO 3166-1 alpha-2 code; `videoCategoryId` defaults to
  `0`; `maxResults` is **1–50 (default 5)**; `pageToken` pages charts (not `id` lookups).
- **`mostPopular` is no longer "Trending Now".** Since 2025-07-21 it features the
  _Trending Music, Movies, and Gaming_ charts (revision history, 2025-07-10 entry).
- **Granular quota buckets (2026-06-01).** `videos.insert` and `search.list` have their
  own buckets; everything else stays in the existing bucket.
- **`videos.batchGetStats` (2026-06-03).** `GET https://www.googleapis.com/youtube/v3/videos:batchGetStats`,
  params `id` (comma-separated, required) and `part` (`contentDetails`, `id`, `snippet`,
  `statistics`). **1 unit per request in its own bucket, default 10,000 units/day.**
  Response: `items[].{id, statistics.{viewCount, likeCount, commentCount}, snippet.publishTime, contentDetails.{duration, durationMillis}}`
  plus `summary.{requestedVideoCount, succeededVideoCount, failedVideoCount, failedVideoIds}`.
  API keys work for public videos (OAuth required for non-public).
- **View counting changed:** "Starting August 24, 2026, for all video formats (long-form,
  Live, and Shorts) … `viewCount` will be updated to count views the moment a video
  begins to play" (video resource page). Shorts already counted every start/replay since 2025-03-31.
- `statistics.dislikeCount` is private since 2021-12-13; `favoriteCount` is deprecated (always 0).
- Thumbnail keys include `default`, `medium`, `high`, `standard`, `maxres`, and newer `fhd`, `qhd`, `uhd`.
- `contentDetails.duration` is ISO 8601 (`PT15M33S`).
- The video resource has **no field that identifies a Short.**
- **`search.list`**: "a quota cost of 1 unit in the Search Queries quota bucket", **100 calls/day**
  by default. Params used: `q` (supports `-` NOT and `|` OR), `type=video`, `regionCode`,
  `relevanceLanguage` (ISO 639-1), `publishedAfter`/`publishedBefore` (RFC 3339), `order`
  (`date`, `rating`, `relevance` default, `title`, `viewCount`), `maxResults` 0–50 (default 5),
  `videoDuration` (`any`; **`short` = under 4 minutes**; `medium` 4–20 min; `long` > 20 min),
  `videoCategoryId`, `safeSearch` (`moderate` default), `pageToken`. Items carry `id.videoId`.
- **`channels.list`**: 1 unit; exactly one of `id` (comma-separated), `forHandle`, `forUsername`,
  `mine`. `contentDetails.relatedPlaylists.uploads` is "the ID of the playlist that contains the
  channel's uploaded videos". No maximum id count is stated.
- **`playlistItems.list`**: 1 unit; `playlistId`, `maxResults` 0–50 (default 5), `pageToken`;
  items carry `contentDetails.videoId` and `contentDetails.videoPublishedAt`. **No ordering
  guarantee is stated** for uploads playlists.

## ACCESS REQUIREMENTS

- Google Cloud project with YouTube Data API v3 enabled and an API key → `YOUTUBE_API_KEY`.
- The key is sent in the `X-goog-api-key` header, never in the URL, so it cannot leak through logged URLs.
- No OAuth: only public data is read.

## DISCOVERY CAPABILITIES

| Capability           | Implementation                                                             |
| -------------------- | -------------------------------------------------------------------------- |
| `discovery.trending` | `videos.list?chart=mostPopular` for every `regionCode` × `videoCategoryId` |
| `discovery.url`      | `videos.list?id=` for any YouTube URL form (manual submissions)            |
| `metrics.refresh`    | `videos:batchGetStats`, 50 ids per request                                 |

SourceQuery params (`kind: "trending"`): `regionCode` (list or CSV, **required** — no
default country), `videoCategoryId` (list, optional), `maxResults` (1–50, default 50),
`pages` (1–10, default 1). Falls back to `SourceQuery.region` when `regionCode` is absent.

Search params (`kind: "search"`, one theme per SourceQuery — themes are data, never code):
`q` (required), `regionCode`, `relevanceLanguage`, `publishedAfter` **or**
`publishedWithinHours`, `order` (default `relevance`), `videoDuration` (default `any`),
`videoCategoryId`, `safeSearch` (default `moderate`), `maxResults` 1–50 (default 25),
`pages` 1–5 (default 1; each page = 1 `search.list` call). Search hits that `videos.list`
no longer returns are skipped. Sighting context keeps the search, observation key
`search:<q>:<region>`.

Channel-feed params (`kind: "channel_feed"`): `channelId` (UC…), `handle` (@…), and/or
`uploadsPlaylistId` (UU…, skips `channels.list`); `maxPerChannel` 1–50 (default 10);
`publishedWithinHours` (skips older uploads **before** spending `videos.list` quota).
Observation key `channel:<channel>`. No seed channels are configured in code.

**Short-form heuristic.** The only short-form signal used is **duration**, applied as the
generic `--max-duration` filter _after_ normalization. Filtered videos are counted and
sampled on the discovery run (`discovery_runs.stats.filteredSamples`), never silently dropped.
The adapter does not label anything a "Short".

## METRICS AVAILABLE

| Metric   | Source field              | When absent                                  |
| -------- | ------------------------- | -------------------------------------------- |
| views    | `statistics.viewCount`    | `unavailable: unknown`                       |
| likes    | `statistics.likeCount`    | `unavailable: unknown` (docs do not say why) |
| comments | `statistics.commentCount` | `unavailable: unknown`                       |
| shares   | —                         | `unavailable: not_provided_by_platform`      |

## QUOTA / RATE LIMIT INFORMATION

Default source budgets (`sources.daily_quota_budgets`, editable per source; manifest
defaults fill buckets a source row does not list):
`{"default": 10000, "search.list": 100, "videos.batchGetStats": 10000}`.
One search page = 1 `search.list` + 1 `default` unit. One seed-channel run = 1 `channels.list`
per 50 channel ids (+1 per handle) + 1 `playlistItems.list` per channel + 1 `videos.list` per 50 videos. One chart page = 1 `default` unit;
one refresh of ≤50 videos = 1 `videos.batchGetStats` unit. Usage is written to `api_usage`
per UTC day (YouTube resets quota at midnight Pacific time, so accounting is approximate
at the day boundary). Errors `quotaExceeded`/`dailyLimitExceeded` → `quota_exceeded`;
`rateLimitExceeded`/`userRateLimitExceeded` or HTTP 429 → `rate_limited`.

## LIMITATIONS

- **`mostPopular` is a weak funny-video signal now** (music/movies/gaming). Comedy (23) or
  Pets & Animals (15) filters may return few or no videos in many regions.
- `batchGetStats` publishes **no per-request id limit**. The 50-id batch is an
  **application batch size** (mirrors `videos.list?id=`), configurable with
  `YOUTUBE_STATS_BATCH_SIZE` — not a documented YouTube limit.
- `videoDuration=short` is "under 4 minutes", **not** "is a YouTube Short".
- Uploads-playlist order is not documented; `maxPerChannel` takes the first N items returned.
- `failedVideoIds` gives no reason, so unreturned videos are `availability: unknown`.
- Snippet has no `@handle`; creators are keyed by channel id with the channel title as display name.
- **Views before and after 2026-08-24 are not comparable.** Use velocity between our own snapshots.
- `search.list` is the scarcest resource (100 calls/day); see the quota strategy in `docs/architecture.md`.

## COMPLIANCE CONSIDERATIONS

- Metadata and links only; **no video downloads**, no media URL extraction.
- Raw API payloads are stored in `videos.raw_payload` for authoritative observations only.
  The Developer Policies' data storage/refresh obligations were **not re-read this
  session**; a retention job is required before production use.
- One API project per client; never shard keys to gain quota.

## OPEN QUESTIONS

1. Which search themes and seed channels perform best — now a data/tuning question (SourceQueries), not code.
2. Actual per-request id limit of `batchGetStats`.
3. Exact data retention/refresh windows in the current Developer Policies.
4. Whether likes are omitted or zero when hidden by the creator.
