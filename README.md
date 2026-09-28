# viral-discovery

Viral/funny short-form video **intelligence** agent: discover → normalize → dedupe →
track engagement → score → categorize → human review. Links to and analyzes public
metadata only; never downloads third-party media.

**Status: Phase 2 — multi-source discovery v1.** Adapters for YouTube, Twitch, Bluesky,
and manual URLs (incl. TikTok oEmbed) store normalized videos, cross-source sightings,
and metric snapshots in PostgreSQL. No scoring, classification, or UI yet.
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
packages/pipeline            platform-agnostic ingestion, submission, metric refresh
packages/adapters/contract   SourceAdapter contract, registry, HTTP helper, contract test kit
packages/adapters/youtube    YouTube Data API v3 (mostPopular charts, batchGetStats)
packages/adapters/twitch     Twitch Helix clips
packages/adapters/bluesky    Bluesky AppView search (native videos + linked videos)
packages/adapters/manual-url pasted URLs (+ TikTok oEmbed)
packages/adapters/wiring     the one place adapters are instantiated
docs/                  architecture + per-source access/compliance notes
```
