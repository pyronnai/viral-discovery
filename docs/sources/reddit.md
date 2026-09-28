# Source: Reddit

_Verified 2026-09-28. Adapter status: **planned, not implemented — access-gated.** No
Reddit code exists; `vd discover reddit` explains why._

Primary references (read directly 2026-09-28 in a browser; the help center blocks automated fetchers):

- Responsible Builder Policy — https://support.reddithelp.com/hc/en-us/articles/42728983564564 ("Updated 3 months ago")
- Reddit Data API Wiki — https://support.reddithelp.com/hc/en-us/articles/16160319875092 ("Updated 4 months ago")
- Data API Terms / Developer Terms — linked from the wiki; **not re-read this session**

## VERIFIED CURRENT BEHAVIOR

From the **Responsible Builder Policy**:

- **Approval is required:** "You must request access and get explicit approval before
  accessing any Reddit data through our API."
- **Commercial use needs explicit written approval** — anyone wanting Reddit data for
  commercial purposes must contact Reddit, which responds only if the proposal fits its criteria.
- **Developer Platform first:** developers of non-commercial apps "should use the Developer
  Platform ('Devvit')". If a use case is not supported by Devvit, a ticket must be filed.
- Must not "sell, license, share, or otherwise commercialize Reddit data without express
  written approval", including use to train ML/AI models.
- No multiple accounts or duplicate requests for the same use case; no exceeding limits;
  no inferring sensitive characteristics; no re-identification.
- Apps (bots, AI agents) must register a developer profile and have a clearly specified purpose and scope.

From the **Data API Wiki**:

- Access is requested via Reddit's contact form; use is subject to the Responsible Builder
  Policy, Developer Terms, and Data API Terms. The wiki warns that legacy docs may be out of date.
- **OAuth is required**; traffic without OAuth or login credentials is blocked.
- User-Agent: `<platform>:<app ID>:<version string> (by /u/<reddit username>)`.
- **Free access limit: 100 queries per minute per OAuth client id**, averaged over 10 minutes.
  Headers: `X-Ratelimit-Used`, `X-Ratelimit-Remaining`, `X-Ratelimit-Reset`.
- **Deletion obligations:** deleted posts/comments must be deleted from our store (title,
  body, embedded URLs, …); deleted accounts' identifying data must be removed. Reddit
  **strongly recommends deleting stored user data and content within 48 hours**, and
  retaining deleted content even if anonymized is a violation.

## ACCESS REQUIREMENTS

1. Request and receive explicit approval for Data API access.
2. Because this project may feed monetized content workflows, treat it as **commercial**:
   obtain **explicit written approval** (likely a separate agreement) before any use.
3. Then: OAuth client id/secret (`REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`) and a
   compliant `REDDIT_USER_AGENT` — reserved in `.env.example`, unused.

## DISCOVERY CAPABILITIES

None implemented. If approved, the intended design is Reddit as a **signal and link
resolver** (like Bluesky): posts linking to YouTube/Twitch/TikTok become sightings of the
canonical video, with the post in sighting context.

## METRICS AVAILABLE

None implemented. Reddit has no public view counts; post score/comments would describe the
post, not the linked video (same rule as Bluesky).

## QUOTA / RATE LIMIT INFORMATION

100 QPM per OAuth client id (free tier, 10-minute average) — only after approval.

## LIMITATIONS

- Blocked on approval; no unauthenticated fallback is allowed (`.json` endpoints or scraping are out of scope).
- The 48-hour deletion recommendation conflicts with long-lived storage.

## COMPLIANCE CONSIDERATIONS

- **Do not implement Reddit scraping. Do not use unauthenticated endpoints.**
- Any future adapter needs a retention job that re-checks or purges Reddit-origin data within 48 hours.
- The AI-training prohibition matters if Reddit text ever feeds an LLM classifier.

## OPEN QUESTIONS

1. Will Reddit approve this use case, and on what commercial terms?
2. Is Devvit a viable path at all? (It runs apps inside Reddit; it is not an export API.)
3. Does "delete within 48 hours" apply to derived data (scores/labels computed from a post)?
