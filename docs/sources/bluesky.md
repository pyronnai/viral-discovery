# Source: Bluesky

_Verified 2026-09-28. Adapter status: **implemented** (`packages/adapters/bluesky`,
adapter id `bluesky`). Tested live against `https://api.bsky.app` on 2026-09-28._

Bluesky is where the architecture's **source ≠ canonical platform** rule matters most:
a Bluesky post that links a YouTube Short produces a sighting _from Bluesky_ of a video
_on YouTube_. It never produces a fake "Bluesky video".

Primary references (read 2026-09-28):

- Lexicons (authoritative schemas), bluesky-social/atproto on GitHub:
  `app.bsky.feed.searchPosts`, `app.bsky.feed.getPosts`, `app.bsky.feed.defs#postView`,
  `app.bsky.embed.external`, `app.bsky.embed.video`, `app.bsky.embed.recordWithMedia`
- Rate limits doc — bluesky-social/bsky-docs `docs/advanced-guides/rate-limits.md`
  (the docs.bsky.app site now redirects and renders client-side, so the source was read)

## VERIFIED CURRENT BEHAVIOR

- **`app.bsky.feed.searchPosts`**: `q` (required, Lucene syntax recommended), `sort`
  (`top`|`latest`, default `latest`), `since`, `until`, `mentions`, `author`, `lang`,
  `domain` (posts linking to a host), `url`, `tag` (AND-matched), `limit` 1–100 (default
  25), `cursor` (may not scroll the whole result set). The lexicon states it **"may
  require authentication … for some service providers."**
- **Hosts:** the rate-limits doc says `api.bsky.app` and `public.api.bsky.app` are direct
  AppView endpoints that **do not support authentication**, `public.api.bsky.app` is cached,
  and both have "generous" (unpublished) limits.
- **Observed 2026-09-28 (not documented):** unauthenticated `searchPosts` returned
  **HTTP 403 from `public.api.bsky.app`** and **HTTP 200 from `api.bsky.app`**. The adapter
  defaults to `api.bsky.app` (configurable: `BLUESKY_APPVIEW_URL`).
- **`app.bsky.feed.getPosts`**: up to **25** AT-URIs; missing posts are omitted.
- **Post view** (`postView`): required `uri, cid, author, record, indexedAt`; optional
  `embed, replyCount, repostCount, likeCount, quoteCount, bookmarkCount, labels, …`.
- **Link cards**: `app.bsky.embed.external#view` → `external.{uri, title, description, thumb}`.
  Links may also appear as rich-text facets (`app.bsky.richtext.facet#link`).
- **Native video**: `app.bsky.embed.video#view` → `{cid, playlist (HLS URL), thumbnail?, alt?, aspectRatio?}`.
  **No duration and no view count** are exposed. Also possible inside
  `app.bsky.embed.recordWithMedia#view.media`.

## ACCESS REQUIREMENTS

None for public search/read. No credentials are configured or required.

## DISCOVERY CAPABILITIES

`discovery.search` (SourceQuery kind `search`) with params `q` (required), `sort`, `since`,
`until`, `lang`, `domain`, `author`, `tag`, `pageSize` (1–100), `pages` (1–10), and
`include` = `both` (default) | `native` | `links`.

For each post the adapter emits:

1. **Linked videos** — every link (card + facets) that `@vd/url-identity` resolves to a
   YouTube video, TikTok video, or Twitch clip, once per post × video. Normalized as a
   **reference** to the canonical platform: identity + canonical URL, `metrics: null`,
   the link-card title only if the card is for that same video. Unsupported links are ignored.
2. **Native Bluesky videos** — normalized as platform `bluesky`, id = post AT-URI,
   canonical URL `https://bsky.app/profile/<did>/post/<rkey>`.

Sighting context keeps the post: `postUri`, `postUrl`, `postCid`, `postAuthor
{did, handle, displayName}`, `postCreatedAt`, `postIndexedAt`, `postEngagement
{likes, reposts, replies, quotes}` (the **post's** numbers at observation time), `linkedUrl`, `query`, `rank`.

`metrics.refresh` re-reads native video posts via `getPosts` (25 per call).

## METRICS AVAILABLE

Native Bluesky videos only: `likes` = `likeCount`, `comments` = `replyCount`. Views and
shares: `not_provided_by_platform` (reposts/quotes are kept in context, not relabeled as shares).
**Linked videos get no metrics from Bluesky** — post engagement is evidence that a video
is spreading, not the video's own engagement.

## QUOTA / RATE LIMIT INFORMATION

No published AppView limit ("generous"; contact Bluesky if rate-limited). One request per
page is recorded in the `default` bucket for local accounting.

## LIMITATIONS

- Unauthenticated search working on `api.bsky.app` is **observed, not guaranteed**.
- Native videos have no duration, so `--max-duration` keeps them (counted as
  `keptWithUnknownDuration`).
- **TikTok short links** (`vm.tiktok.com`, `vt.tiktok.com`) are not resolved; in a live
  sample of 49 TikTok links on Bluesky, **42 were short links**. Only full
  `tiktok.com/@user/video/<id>` URLs become sightings.
- Search cursors may not reach the whole result set.

## COMPLIANCE CONSIDERATIONS

- No scraping of `bsky.app`; only XRPC endpoints. The HLS `playlist` URL is **never stored**.
- Sighting context stores post author identity (public). Deleted posts should be purged;
  a retention job is required before production use.

## OPEN QUESTIONS

1. Will unauthenticated `searchPosts` remain available on `api.bsky.app`? If not, add
   optional app-password auth via a PDS.
2. Should TikTok short links be resolved (one HEAD request per link to TikTok)? That is a
   policy decision — it is not an official TikTok API.
3. Bluesky's developer guidelines on retaining post data were not reviewed this session.
