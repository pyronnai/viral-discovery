# viral-discovery

Viral/funny short-form video **intelligence** agent: discover → normalize → dedupe →
track engagement → score → categorize → human review. Links to and analyzes public
metadata only; never downloads third-party media.

**Status: Phase 4 — content understanding + human review dashboard.** Multi-source
discovery (YouTube, Twitch, Bluesky, manual URLs incl. TikTok), a deterministic breakout
score, model-based content classification (labels, review flags, "why this may work"
hypotheses), and a server-rendered review dashboard with cluster-level decisions.
See [`docs/architecture.md`](docs/architecture.md) and [`docs/sources/`](docs/sources/).

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
pnpm cli tick                          # due queries → due refreshes → rescore stale → duplicate scan of new videos (cron this)
pnpm cli refresh-metrics youtube --due --ladder 2h,8h,24h,72h
pnpm cli rescore --explain             # stale only by default; --unscored / --recent 24 / --video <id>
```

## Review dashboard

```bash
pnpm --filter @vd/web dev        # http://localhost:3000 (reads the root .env)
pnpm --filter @vd/web build      # production build
pnpm cli classify --eligible     # needs ANTHROPIC_API_KEY; the dashboard works without it
pnpm cli duplicates scan         # near-duplicates of unprocessed videos (bounded; --recent/--platform/--video/--limit)
pnpm cli duplicates list         # possible duplicates with evidence (--status confirmed|auto_confirmed|rejected)
pnpm cli duplicates explain <videoA> <videoB>   # evidence for one pair, stores nothing
```

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
