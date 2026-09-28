# Source: YouTube

_Researched 2026-09-28. Re-verify before implementing the adapter; this API changed several times in 2025–2026._
_Adapter status: **not implemented**._

Primary references:

- Quota and Compliance Audits — https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits (page last updated 2026-09-14)
- Revision History — https://developers.google.com/youtube/v3/revision_history
- Quota cost calculator — https://developers.google.com/youtube/v3/determine_quota_cost (**not read this session**)
- Developer Policies — https://developers.google.com/youtube/terms/developer-policies (**not read this session**)

## VERIFIED CURRENT BEHAVIOR

Read directly from the official pages above on 2026-09-28:

- **Default allocation is split by method.** A project gets 100 `search.list` calls,
  100 `videos.insert` calls, and 10,000 units per day combined for all other endpoints.
- **Granular quota buckets (2026-06-01).** YouTube is moving to per-method quota
  buckets, starting with `videos.insert` and `search.list`; calls to other methods
  stay in the existing bucket.
- **`videos.batchGetStats` (2026-06-03).** New method returning video statistics;
  1 unit per call in its own bucket, default 10,000 units/day.
- **`mostPopular` chart changed (2025-07-21).** It no longer mirrors the general
  "Trending Now" list; it now features the Trending Music, Movies, and Gaming charts,
  alongside the deprecation of YouTube's Trending page.
- **View counting changed (announced 2026-08-27).** Public views for all formats now
  count when playback starts from the first frame (including autoplay). Engaged views
  are unchanged but are used for monetization/analytics, not the public count.
  Earlier (2025-03-31) Shorts views had already moved to counting every start/replay.
- **More quota requires a compliance audit** via the Audit and Quota Extension Form.
- **Dislike counts** are private (only returned to the video owner) since 2021-12-13.
- **Higher-resolution thumbnail keys** (`fhd`, `qhd`, `uhd`) exist for some videos (2026-09-11).
- (Publishing, later) Uploads via unverified API projects created after 2020-07-28 are
  locked to private until the project passes an audit.

## ASSUMPTIONS (unverified — confirm before relying on them)

- Per-call unit cost of `videos.list` and `channels.list` is 1 unit. _Not checked
  against the current quota calculator this session._
- `batchGetStats` can replace `videos.list` for metric refreshes. _Its parameters,
  batch size, and returned fields were not read._
- Channel upload feeds (Atom/RSS at `youtube.com/feeds/videos.xml`) still exist and
  are usable for `channel_feed` discovery without quota. _Not verified; also need to
  confirm how the API Terms apply to feed data._
- There is no API field that identifies a Short. A duration heuristic would be a guess.
- Likes can be hidden by creators and then absent from `statistics`.
  _Map to `hidden_by_owner` only once confirmed in the reference docs._

## ACCESS REQUIREMENTS

- Google Cloud project with YouTube Data API v3 enabled; API key for public reads
  (`YOUTUBE_API_KEY`). OAuth is not needed for public discovery.
- One API project per API client (per the policies summary; re-read the Developer
  Policies text before relying on this). Never shard across projects to gain quota.

## QUOTAS / RATE LIMITS

Budgets must live in `sources.daily_quota_budgets`, never in code. Starting values
from the verified defaults:

```json
{ "search.list": 100, "default": 10000, "videos.batchGetStats": 10000 }
```

Treat `search.list` as the scarcest resource. Actual allocations are visible in the
Google Cloud Console → Quotas and may differ per project.

## COMPLIANCE CONSIDERATIONS

- Store metadata and links only; **never download video files**.
- The Developer Policies contain data storage/refresh obligations for API data.
  _Exact windows not verified this session_ — read the policy text and implement the
  retention job before production use.
- Because of the 2026-08-27 view-count change, **views before and after that date are
  not comparable**. Scoring must use velocity between our own snapshots, not
  historical absolute views.

## OPEN QUESTIONS

1. **Where does "trending funny" come from now?** The `mostPopular` chart is
   music/movies/gaming only, so the earlier plan (mostPopular × Comedy/Pets categories)
   likely no longer works. Candidates: curated channel feeds, targeted `search.list`
   within its 100-call budget, and links surfaced by other sources.
2. Does `batchGetStats` accept 50+ ids per call, and which fields does it return?
3. Exact data-retention/refresh windows in the current Developer Policies.
4. Whether channel Atom feeds are covered by API Terms or by general site terms.
