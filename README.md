# viral-discovery

**A multi-source viral-video discovery and review inbox.**

The system finds and prioritizes candidate funny/viral videos: discover → rank (deterministic
breakout score) → classify → deduplicate across platforms → review → save → open the
original → track what you obtained and already used. **You** do the editing, compilation,
captions and publishing externally — the system never downloads media, plans compilations,
or publishes anything.

**Status: Phase 5 — daily viral-video inbox.** Sources: YouTube, Twitch, Bluesky, and manual
URLs (incl. TikTok via oEmbed); Reddit is access-gated. No source is the "center": every
adapter feeds the same inbox. See [`docs/architecture.md`](docs/architecture.md) and
[`docs/sources/`](docs/sources/).

## Requirements

Node.js **≥ 22.9.0** (scripts use `node --env-file-if-exists`, added in v22.9.0), pnpm 9
(`packageManager: pnpm@9.15.9`; `corepack enable` or `npx pnpm@9.15.9`), PostgreSQL ≥ 13
(uses `gen_random_uuid()`).

## Setup

```bash
pnpm install
cp .env.example .env        # then edit DATABASE_URL
pnpm db:migrate             # apply Drizzle migrations
pnpm cli health             # config + database + schema + job-queue checks
pnpm cli adapters           # which sources are ready / which env vars are missing
pnpm worker                 # start the pg-boss worker (Ctrl+C to stop)
```

Only `DATABASE_URL` is required. Bluesky discovery and manual URL submission need no
credentials; YouTube needs `YOUTUBE_API_KEY`; Twitch needs `TWITCH_CLIENT_ID` +
`TWITCH_CLIENT_SECRET`. A missing key disables only that adapter.

## Discovery

```bash
pnpm cli discover bluesky --param q=funny --param domain=youtube.com
pnpm cli discover youtube --param regionCode=US,GB --param videoCategoryId=23 --max-duration 180
pnpm cli discover twitch --param gameId=509658 --param lookbackHours=24
pnpm cli discover twitch --kind channel_feed --param broadcasterId=12345
pnpm cli discover --query <source_queries.id>        # run a stored SourceQuery
pnpm cli submit-url 'https://www.tiktok.com/@user/video/7412345678901234567'
pnpm cli refresh-metrics youtube --limit 200         # append metric snapshots
```

## Scheduled discovery, refresh ladder, and scoring

```bash
pnpm cli queries add youtube --kind search --param q="funny animals" \
  --param publishedWithinHours=48 --param order=viewCount --cadence 360
pnpm cli queries add youtube --kind channel_feed --param channelId=UC... --cadence 180
pnpm cli queries add bluesky --kind search --param q=funny --param domain=tiktok.com --cadence 60
pnpm cli queries list
pnpm cli tick                          # one full pass (see Scheduling below)
pnpm cli refresh-metrics youtube --due --ladder 2h,8h,24h,72h
pnpm cli rescore --explain             # stale only by default; --unscored / --recent 24 / --video <id>
```

## Scheduling (recurring discovery)

There is no external scheduler and no job producer: **`pnpm cli tick` is the production
loop.** Each run is idempotent and does, in order:

1. due discoveries (stored queries whose cadence has elapsed),
2. due metric refreshes (per-platform refresh ladder),
3. rescoring of stale scores,
4. near-duplicate scan of new/changed videos (failures never fail the pass),
5. classification of eligible candidates — only if `ANTHROPIC_API_KEY` is set
   (`--no-classify` to skip, `--classify-limit` to bound cost; failures never fail the pass).

Run it from cron, e.g. every 15 minutes (a run is quick when nothing is due):

```cron
*/15 * * * * cd /path/to/viral-discovery && pnpm cli tick >> var/tick.log 2>&1
```

Avoid overlapping runs (e.g. wrap with `flock -n /tmp/vd-tick.lock`); repeated or overlapping
passes are still safe — runs, sightings, snapshots, scores and classifications are idempotent.
The dashboard's **Discovery health** page (`/health`) shows whether sources are actually
finding fresh videos. `pnpm worker` remains available for queued jobs, but nothing enqueues
them automatically yet.

## Daily inbox (dashboard)

```bash
pnpm --filter @vd/web dev        # http://localhost:3000 (reads the root .env)
pnpm --filter @vd/web build      # production build
pnpm cli classify --eligible     # needs ANTHROPIC_API_KEY; the dashboard works without it
pnpm cli duplicates scan         # near-duplicates of unprocessed videos (bounded; --recent/--platform/--video/--limit)
pnpm cli duplicates list         # possible duplicates with evidence (--status confirmed|auto_confirmed|rejected)
pnpm cli duplicates explain <videoA> <videoB>   # evidence for one pair, stores nothing
```

- **🔥 Viral Now** (default): fresh (≤ 72 h), scored/provisional breakouts you haven't triaged,
  ranked by the deterministic virality score. **👀 Unreviewed**, **★ Saved** (shortlist),
  **⬇ Obtained** (you got the media externally, not yet used), **✓ Already used**, Rejected, All.
- Quick category chips (funny, animals, fails, reactions, memes, unexpected), filters (platform,
  minimum score, freshness, creator, rights) and sorts (virality, newest, fastest growing,
  most viewed, recently discovered) — all in the URL.
- Per card: **▶ Open original** (plus "Also on" links for confirmed reposts on other
  platforms), ☆ Save, ⬇ Obtained, Used; Approve/Reject and Details as secondary actions.
- Select several cards for bulk Save / Obtained / Used / Reject (broad actions ask first), and
  export the selection or the current view as CSV/JSON — metadata and links only.
- **Saved ≠ Obtained ≠ Used.** Saved = "I want this clip"; Obtained = you obtained the source
  yourself (tracking only); Already used = never surface this content as fresh again —
  including reposts of it confirmed on other platforms.
- Rights are shown, never assumed: "Rights: Unknown" is not permission, and doesn't block saving.

Possible duplicates are confirmed or rejected on the candidate detail page; see "Identity:
exact vs near-duplicate" in the architecture doc.

Scores are `scored`, `provisional`, or `insufficient_evidence` (no value); see
"Virality / breakout scoring v1" in [`docs/architecture.md`](docs/architecture.md).

Every command accepts `--json` and exits non-zero on failure. Logs go to stderr.
A video is stored once per `(platform, platform_video_id)` no matter which source saw it;
each observation is a sighting (see "Source ≠ canonical platform" in the architecture doc).

## Scripts

| Command                                                      | What it does                                                                                                                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                                                  | ESLint (strict, type-aware)                                                                                                                                                     |
| `pnpm format` / `pnpm format:check`                          | Prettier                                                                                                                                                                        |
| `pnpm typecheck`                                             | `tsc` per workspace package                                                                                                                                                     |
| `pnpm test`                                                  | Vitest (pipeline DB tests use in-process PGlite). `TEST_DATABASE_URL` adds worker integration tests; `LIVE_API_TESTS=1` (+ credentials, `LIVE_TIKTOK_URL`) runs live API tests. |
| `pnpm db:generate`                                           | Generate a migration from `packages/db/src/schema.ts`                                                                                                                           |
| `pnpm db:migrate`                                            | Apply migrations                                                                                                                                                                |
| `pnpm cli <health\|config-check\|db-check> [--json]`         | Infrastructure checks                                                                                                                                                           |
| `pnpm cli <adapters\|discover\|submit-url\|refresh-metrics>` | Discovery (see above)                                                                                                                                                           |
| `pnpm worker`                                                | Run the worker                                                                                                                                                                  |

## Layout

```
apps/worker                  pg-boss runtime (queues, handler registration)
apps/cli                     infrastructure + discovery CLI
packages/config              env validation (Zod) + logger (Pino)
packages/core                domain types, metric model, job contracts
packages/db                  Drizzle schema, migrations, health check
packages/url-identity        URL → canonical (platform, video id, URL)
apps/web                     Next.js review dashboard (internal, single-user)
packages/review              feed/detail queries, review + rights actions, view models
packages/classification      content classifier (provider abstraction, taxonomy, Zod-validated output)
packages/dedupe              near-duplicate detection (pHash, evidence, safe thumbnail fetch, merges, planner query)
packages/url-resolution      allowlisted TikTok short-link expansion (network)
packages/scoring             pure, deterministic breakout score v1
packages/pipeline            ingestion, submission, refresh ladder, scheduling, score lifecycle
packages/adapters/contract   SourceAdapter contract, registry, HTTP helper, contract test kit
packages/adapters/youtube    YouTube Data API v3 (mostPopular charts, batchGetStats)
packages/adapters/twitch     Twitch Helix clips
packages/adapters/bluesky    Bluesky AppView search (native videos + linked videos)
packages/adapters/manual-url pasted URLs (+ TikTok oEmbed)
packages/adapters/wiring     the one place adapters are instantiated
docs/                  architecture + per-source access/compliance notes
```
