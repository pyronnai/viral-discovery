# Source: TikTok

_Manual/oEmbed verified 2026-09-28 (short links 2026-09-29). Direct discovery added 2026-10-03
(Bright Data API documentation read that day; **not yet run against the live API** — no token)._

TikTok enters the system three ways:

1. **Direct discovery** (`tiktok` adapter): keyword search, URL lookup and metric refresh
   through a **provider-neutral** `TikTokPublicProvider`. First provider: **Bright Data**.
   Disabled unless `BRIGHTDATA_API_TOKEN` is set.
2. **References** — TikTok links found on other sources (Bluesky, …). When the `tiktok`
   adapter is configured, the generic reference enrichment looks them up on it (one batched
   provider job per run) and they get authoritative metadata + metrics; the original
   sighting is kept.
3. **Manual URLs** (`manual-url` adapter, oEmbed): identity + caption/thumbnail, no metrics.

## Direct discovery: TikTokPublicProvider (packages/adapters/tiktok)

TikTok's official Display API is per-user (not global public discovery) and the Research API
is not real-time, so public data comes from a third-party provider. The application only sees
`TikTokPublicPost` — video id, public URL, creator username/public id/followers, caption,
publish time, duration, cover image, views/likes/comments/shares (null = not reported, never
0), hashtags, post type. Provider fields end at the provider implementation.

**Never collected:** media files or media URLs (`video_url`, `cdn_url`, `cdn_link`), subtitles,
session tokens (`tt_chain_token`, `secu_id`), bios, avatars, other users' comments, tagged
users. The provider maps an **allowlist** of fields, so nothing else can reach the database.

| Operation                                                        | Adapter capability                     | SourceQuery                                                              |
| ---------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| Keyword / hashtag search                                         | `discovery.search`                     | `kind=search`, `q`, `maxResults` (≤ 100, default 20), optional `country` |
| Known URL lookup (reference enrichment, `submit-url` enrichment) | `discovery.url` (+ batch `lookupUrls`) | —                                                                        |
| Metric refresh (refresh ladder)                                  | `metrics.refresh` (batched)            | —                                                                        |

Stored queries work like other sources, e.g.
`pnpm cli queries add tiktok --kind search --param q="funny animals" --param maxResults=20 --cadence 360`.
Each query is one sighting (`observationKey = search:<q>`); a video found by several queries is
one canonical TikTok video (`(tiktok, <numeric id>)`) with several sightings.

Photo/carousel posts are quarantined (not videos); provider error records and malformed
records are quarantined with their reason, never silently dropped.

### Bright Data (first provider)

Documented API (docs.brightdata.com; dataset schema from `docs.brightdata.com/scrapers-full.json`):

- Dataset **"TikTok - Posts"**, id `gd_lu702nij2f790tmv9h` (`BRIGHTDATA_TIKTOK_DATASET_ID`).
- `POST /datasets/v3/trigger?dataset_id=…&include_errors=true` with `{"input": [...]}` →
  `{"snapshot_id"}`; keyword discovery adds `type=discover_new&discover_by=keyword` and input
  `{search_keyword, num_of_posts, country}`; URL collection input `{url, country}`.
- `GET /datasets/v3/progress/{id}` (`starting|running|ready|failed|canceled`) → `GET
/datasets/v3/snapshot/{id}?format=json`. Polled every 10 s, bounded by
  `BRIGHTDATA_MAX_WAIT_SECONDS` (default 600).
- Auth `Authorization: Bearer <BRIGHTDATA_API_TOKEN>` (header only; errors name the variable,
  never the value; the logger redacts it).
- Field mapping: `post_id`/`url` → id/URL, `profile_username`, `profile_id`|`account_id`,
  `profile_followers`, `description`, `create_time`, `video_duration` (s), `preview_image`,
  `play_count`→views, `digg_count`→likes, `comment_count`, `num_share_count`|`share_count`
  (the latter is typed text) → shares, `hashtags`, `post_type`/`carousel_images`.
- **Billed per delivered record.** Accounting buckets: `records` (local cost guard, default
  1 000/day, override via `sources.daily_quota_budgets`; requests never ask for more records
  than remain) and `requests` (HTTP calls). Both show on `/health`.
- Keyword discovery's published schema lists only `url`/`discovery_input`; the API reference
  example returns full post records. Both are handled: URL-only records keep identity and
  their metrics stay unavailable.
- Live tests: `LIVE_API_TESTS=1 LIVE_BRIGHTDATA_TESTS=1 BRIGHTDATA_API_TOKEN=…` (billed).

### Scoring

TikTok videos with views + publish time are scored by breakout-v2 from the first snapshot (pace,
reach, then measured velocity) with **TikTok's own fallback scales**: pace 50 → 200,000
views/hour, reach 1,000 → 10,000,000 views. These are **initial, versioned fallbacks** (approved
2026-10-03), not calibrated TikTok distributions; once enough TikTok v2 scores exist, the
platform percentile is blended in (as for every platform). Without a publish time a TikTok
video stays `insufficient_evidence` until a second snapshot measures velocity.

### Open: is keyword discovery fresh enough? (must be measured before scheduling)

The documented keyword discovery input is only `search_keyword`, `num_of_posts` (and
`posts_to_not_include`, `country`). There is **no documented published-after filter, no
newest/most-viewed sort, and no trending/viral ordering control**, so we do not know whether
results skew toward old evergreen posts. The provider is deliberately not changed on
speculation. The **first live Bright Data pilot must record the age distribution** of returned
posts (e.g. share published within 24 h / 48 h / 7 d, median age) per query, and TikTok queries
must **not** be added to the recurring scheduler until that shows usable freshness.

## Manual URL support ≠ automated discovery

|                                                                       | Supported?                                    |
| --------------------------------------------------------------------- | --------------------------------------------- |
| A human pastes a TikTok video URL → identity + oEmbed metadata stored | **Yes** (`vd submit-url`)                     |
| TikTok links found in Bluesky posts → sightings of the TikTok video   | **Yes** (full URLs and short links)           |
| Searching on TikTok                                                   | **Via the `tiktok` adapter** (provider)       |
| TikTok view/like/comment/share counts                                 | **Via the `tiktok` adapter**; oEmbed has none |

Primary reference: TikTok oEmbed — https://developers.tiktok.com/doc/embed-videos (page updated 2026-08-04).

## VERIFIED CURRENT BEHAVIOR

- `GET https://www.tiktok.com/oembed?url=<video url>`. **No API key is mentioned.**
- Documented response fields: `version, type, title, author_url, author_name, width,
height, html, thumbnail_width, thumbnail_height, thumbnail_url, provider_url, provider_name`.
- Documented URL form: `https://www.tiktok.com/@{username}/video/{video_id}`.
- Removed videos become unavailable in embeds too.
- **Live check 2026-09-28:** a public video URL returned 200 without credentials. The
  response also contained **undocumented** fields `author_unique_id`, `embed_product_id`,
  `embed_type`; they are **not used**.

### Short/share links (observed 2026-09-29 — not documented by TikTok)

- `https://www.tiktok.com/t/<code>/` answers `HEAD` with **one `301`** whose `Location` is
  `https://www.tiktok.com/@<user>/video/<id>?_r=1&_t=…`; empty body, no cookies set.
- An invalid `vm.tiktok.com/<code>` answers `302` to the TikTok homepage.
- In a live Bluesky sample (q=funny, domain=tiktok.com) **all 49 TikTok links were
  `www.tiktok.com/t/…` short links or full URLs; 42–44 of ~50 were short links.**
- oEmbed **accepts** a `/t/` short URL directly (HTTP 200), but the video id then appears
  only in the undocumented `embed_product_id` field. **Not relied upon.**

## ACCESS REQUIREMENTS

None for oEmbed. The Research API and other TikTok APIs are **not used** (we do not know
that we qualify).

## DISCOVERY CAPABILITIES

Direct keyword search via the `tiktok` adapter (above). Without a provider token, TikTok videos
enter only through manual submission or links on other sources.

## METRICS AVAILABLE

With the `tiktok` adapter: views, likes, comments, shares (as reported). oEmbed/manual alone:
none — metrics stay unavailable.

## QUOTA / RATE LIMIT INFORMATION

No published limit. One oEmbed request per submitted URL (`tiktok-oembed` bucket, local accounting).

## LIMITATIONS

- **Short links** (`vm.tiktok.com/…`, `vt.tiktok.com/…`, `tiktok.com/t/…`) are expanded by
  `@vd/url-resolution` (application design, not a TikTok API):
  - only HTTPS to an **allowlist** (`www.tiktok.com`, `tiktok.com`, `m.tiktok.com`,
    `vm.tiktok.com`, `vt.tiktok.com`), default port, no credentials in the URL;
  - `HEAD`, `redirect: manual`, `credentials: omit`, bodies never read;
  - every `Location` is validated **before** it could be requested; the walk **stops at the
    first `Location` that is a canonical video URL**, so video pages are never requested;
  - ≤ 3 redirects, loop detection, 5 s total timeout;
  - failures are typed (`unexpected_host`, `bad_location`, `redirect_loop`,
    `too_many_redirects`, `not_a_video`, `no_redirect`, `http_error`, `network`, `timeout`)
    and surface as quarantined items (Bluesky) or a clear error (`submit-url`).
  - Live 2026-09-29: 50/50 TikTok links in a Bluesky sample resolved (44 via short links).
- `/@user/photo/<id>` posts are not videos and are rejected.
- oEmbed gives no stable account id, so TikTok creators are stored as handle/display name
  on the video (no `creators` row).
- `thumbnail_url` is a signed CDN URL that likely expires.
- `title` is the video caption as oEmbed returns it.

## COMPLIANCE CONSIDERATIONS

- **No scraping** of TikTok pages, **no media download**, no use of the embed script beyond storing its HTML-free metadata.
- Manually submitted items are `content_origin = discovered_external`; rights stay `unknown`.

## OPEN QUESTIONS

0. **breakout-v2 TikTok scales** (pace and reach ranges) — proposed separately; not set.
1. Is there an official way to get TikTok engagement metrics for this use case (e.g. TikTok for Developers products other than the Research API)?
2. Short-link expansion relies on observed redirect behavior. If TikTok changes it, links
   fail as `not_a_video`/`no_redirect` (visible in run stats) rather than being guessed.
