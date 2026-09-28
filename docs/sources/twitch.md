# Source: Twitch (clips)

_Verified 2026-09-28 against the official Twitch API docs. Adapter status:
**implemented** (`packages/adapters/twitch`, adapter id `twitch`). Not tested live — no
credentials were available this session._

Primary references (read 2026-09-28):

- Get Clips — https://dev.twitch.tv/docs/api/reference/#get-clips
- API guide (rate limits, pagination) — https://dev.twitch.tv/docs/api/guide/
- Client credentials flow — https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#client-credentials-grant-flow

## VERIFIED CURRENT BEHAVIOR

- **`GET https://api.twitch.tv/helix/clips`** with an **app access token or user token**,
  headers `Authorization: Bearer <token>` and `Client-Id`.
- Filters: `broadcaster_id` **or** `game_id` (mutually exclusive, one id each), or `id`
  (up to **100** ids). `started_at`/`ended_at` are RFC 3339 and must be used together.
  `first` 1–100 (default 20). Cursor pagination via `after`/`before`. `is_featured` boolean.
- Response fields: `id, url, embed_url, broadcaster_id, broadcaster_name, creator_id,
creator_name, video_id, game_id, language, title, view_count, created_at,
thumbnail_url, duration, vod_offset, is_featured`.
- 400 for invalid/mutually exclusive params; 401 for a missing/invalid token or Client-Id mismatch.
- **App access token:** `POST https://id.twitch.tv/oauth2/token` with `client_id`,
  `client_secret`, `grant_type=client_credentials` → `access_token`, `expires_in`,
  `token_type`. **No refresh token**; request a new token when it expires.
- **Rate limits:** token bucket per app, refilled over 60 s; 1 point per request by
  default; headers `Ratelimit-Limit`, `Ratelimit-Remaining`, `Ratelimit-Reset` (Unix time); 429 when exceeded.
- Pagination can return an empty page near the end, and duplicates if data changes between pages.

## ACCESS REQUIREMENTS

A registered Twitch application: `TWITCH_CLIENT_ID` + `TWITCH_CLIENT_SECRET`. The secret
is sent only in the token request **body**. The adapter is registered only when both are set.

## DISCOVERY CAPABILITIES

| Capability           | SourceQuery kind | Params                                                         |
| -------------------- | ---------------- | -------------------------------------------------------------- |
| `discovery.trending` | `trending`       | `gameId` (required)                                            |
| `discovery.feed`     | `channel_feed`   | `broadcasterId` (required)                                     |
| `discovery.url`      | —                | clip URLs (`clips.twitch.tv/<id>`, `twitch.tv/<ch>/clip/<id>`) |
| `metrics.refresh`    | —                | `id=` × up to 100                                              |

Shared params: `startedAt`+`endedAt` **or** `lookbackHours` (relative to the run clock),
`first` (1–100), `pages` (1–10), `isFeatured`.

`channel_feed` is served by `discovery.feed`; the `community_feed` kind (same capability in the
contract) is rejected explicitly. Refresh uses Get Clips `id=` in bulk (≤ 100 per call) on
the refresh ladder; only `views` exist, so velocity is view-based and engagement is unavailable.

## METRICS AVAILABLE

`views` = `view_count`. Likes, comments, shares: `not_provided_by_platform`.

## QUOTA / RATE LIMIT INFORMATION

No daily quota. Each Helix call consumes 1 unit of the `default` bucket (local
accounting only). 429 → `rate_limited`, with `retryAfterSeconds` derived from `Ratelimit-Reset`.
On 401 the adapter fetches a new app token **once** and retries.

## LIMITATIONS

- Clips only. VODs and live streams are not supported (`twitch.tv/videos/…` is rejected).
- `broadcaster_name` is a display name; the login (and therefore the profile URL) is not in
  the clip, so `profileUrl`/`handle` stay null.
- Clips missing from a refresh are `availability: unknown` (deleted vs. hidden is not reported).
- The reference does not state the default sort order of Get Clips; we record `rank`
  as returned and do not claim it is "top".

## COMPLIANCE CONSIDERATIONS

- **No clip media is downloaded**; `thumbnail_url`, `url`, and `embed_url` are references only.
- The clipper (`creator_id/creator_name`) is not copied into sighting context (data minimization);
  it remains in the raw payload.
- The Twitch Developer Agreement was **not re-read this session**; review its data
  storage rules before production use.

## OPEN QUESTIONS

1. Default ordering of Get Clips results when filtering by game (view count?).
2. Developer Agreement terms on storing clip metadata long-term.
3. Whether to add broadcaster login resolution (`Get Users`) for profile URLs.
