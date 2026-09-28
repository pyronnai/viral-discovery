# Source: Reddit

_Researched 2026-09-28. Adapter status: **not implemented** — blocked on access approval._

Primary references:

- Reddit Data API Wiki — https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki (updated 2026-05-11)
- Responsible Builder Policy — https://support.reddithelp.com/hc/articles/42728983564564 (**not read directly this session**)
- Data API Terms — https://www.redditinc.com/policies/data-api-terms (**not read this session**)
- Developer Terms — https://www.redditinc.com/policies/developer-terms (**not read this session**)

## VERIFIED CURRENT BEHAVIOR

From the official Data API Wiki, 2026-09-28:

- Use of the Data API is subject to the Responsible Builder Policy, Developer Terms,
  and Data API Terms. Access is requested through Reddit's developer support form.
- **OAuth is required.** Unidentified clients may be throttled or blocked; traffic
  without OAuth or login credentials is blocked.
- **User-Agent is mandatory** in the form
  `<platform>:<app ID>:<version string> (by /u/<reddit username>)`. Generic UAs are heavily limited.
- **Free-tier rate limit: 100 queries per minute per OAuth client id**, averaged over
  a 10-minute window. Monitor `X-Ratelimit-Used`, `X-Ratelimit-Remaining`, `X-Ratelimit-Reset`.
- `robots.txt` applies to search engines, not Data API users.
- **Deletion obligations:** content deleted on Reddit must be deleted from our store
  (title, body, embedded URLs, …). When an account is deleted, all author-identifying
  data must be removed from stored posts. Reddit **recommends deleting stored user data
  and content within 48 hours**. Keeping deleted content — even anonymized — violates their terms.

## ASSUMPTIONS (secondary sources only — verify in the official policy text)

- Self-service API app creation closed in **November 2025**; new apps require manual
  approval under the Responsible Builder Policy (reported by multiple third-party docs).
- **Commercial use requires separate explicit written approval** (quoted by third
  parties from the policy). This project likely counts as commercial if its output feeds
  monetized accounts.
- Approval can take weeks (developer reports, not official).

## ACCESS REQUIREMENTS

- Approved Data API access (request form above), then OAuth client id/secret
  (`REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`) and a compliant `REDDIT_USER_AGENT`.
- Use a dedicated Reddit account whose use matches the approval.
- **Do not** fall back to unauthenticated `.json` endpoints or scraping.

## QUOTAS / RATE LIMITS

Configure as a per-minute limiter, not a daily budget:
`{"requests_per_minute": 100}` (verified free-tier figure). Record usage in
`api_usage` under bucket `default`.

## COMPLIANCE CONSIDERATIONS

- The 48-hour recommendation conflicts with long-lived storage. The Reddit adapter
  should store the **minimum** (post id, permalink, linked media URL, score,
  comment count, timestamps) and the retention job must re-check or purge Reddit-origin
  text within that window. Keep Reddit fields out of long-term raw payloads.
- Reddit is best used as a **signal** (a video is spreading) and a **link resolver**
  (posts pointing to YouTube etc.), with the video itself attributed to its origin platform.
- Reddit has no public view count → scoring for Reddit sightings uses upvotes/comments
  velocity, reported with `views` unavailable (`not_provided_by_platform`).

## OPEN QUESTIONS

1. Will Reddit approve this use case, and under what commercial terms?
2. Does "delete within 48 hours" apply to derived data (our scores/labels computed
   from a post)? Needs reading of the Data API Terms.
3. Is `upvote_ratio` still returned for listing endpoints? (Unverified.)
