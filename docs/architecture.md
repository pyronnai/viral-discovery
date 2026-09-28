# Architecture

_Status: Phase 2 (multi-source discovery v1). Last updated 2026-09-28._

## Purpose

A viral/funny-video **intelligence** agent. It discovers public short-form videos
through permitted access methods, tracks their engagement over time, scores and
categorizes them, and presents the strongest candidates for human review.

It **links to and analyzes** public metadata. It does **not** download, rip, or
re-host third-party media, and it does not depend on any generative-video tool.

## Pipeline

```
 source adapters ─► ingestion ─► normalization ─► enrichment ─► deduplication
                                                                     │
          review ◄─ classification ◄─ scoring ◄─ metric snapshots ◄──┘
```

| Stage                | Responsibility                                                                                                                                                                               | Status (Phase 2)                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Source adapters**  | Talk to one platform via an approved access method; yield `RawItem`s.                                                                                                                        | YouTube, Twitch, Bluesky, manual URL (+TikTok oEmbed). Reddit planned. |
| **Ingestion**        | Run a `SourceQuery` through its adapter, record a `DiscoveryRun`, persist `Sighting`s, account quota in `api_usage`.                                                                         | `@vd/pipeline` `runDiscovery` / `runSourceQuery`, via CLI.             |
| **Normalization**    | `adapter.normalize(raw)` → `NormalizedVideo`, validated by `safeNormalize()` at the boundary. Invalid items are quarantined (counted + sampled on the run), never silently dropped.          | Implemented.                                                           |
| **Identity**         | Map URLs/ids to the canonical `(platform, platform_video_id)` + canonical URL.                                                                                                               | `@vd/url-identity` (YouTube, TikTok, Twitch clips).                    |
| **Enrichment**       | Fill a referenced video from its canonical platform's adapter (`discovery.url`).                                                                                                             | For `submit-url` only. `creator.enrich` not implemented.               |
| **Deduplication**    | Exact: `(platform, platform_video_id)` unique. Near-duplicate: cluster by thumbnail hash + duration + title similarity into `clusters`. Review status is per cluster, so reposts inherit it. | Exact dedupe implemented. Clustering not implemented.                  |
| **Metric snapshots** | Time series of engagement readings. Every metric is explicitly a value or unavailable-with-reason.                                                                                           | Initial snapshot on ingest + `refresh-metrics`.                        |
| **Scoring**          | Velocity/engagement/outlier/freshness score, per-platform normalized, **versioned** (`scores.algorithm_version`).                                                                            | Table only. **Not implemented** (next phase).                          |
| **Classification**   | Multi-label categories + safety flags, **versioned** by taxonomy, model, and prompt.                                                                                                         | Table only. Not implemented.                                           |
| **Review**           | Human decisions (`approved`, `rejected`, `saved`, `already_used`) as an append-only event log per cluster.                                                                                   | Table. No UI.                                                          |

## Packages

| Package                | Role                                                                                                             | Depends on             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `@vd/config`           | Zod-validated env (adapter credentials optional), Pino logger factory.                                           | —                      |
| `@vd/core`             | Storage-agnostic domain types, enums, metric model, job contracts.                                               | —                      |
| `@vd/url-identity`     | Pure URL → canonical identity for YouTube, TikTok, Twitch clips. No network, never guesses.                      | —                      |
| `@vd/adapter-contract` | `SourceAdapter` interface, manifest, normalized schemas, quota budget, registry, HTTP helper, contract test kit. | core, config           |
| `@vd/adapter-*`        | `youtube`, `twitch`, `bluesky`, `manual-url`: one platform/access method each.                                   | contract, url-identity |
| `@vd/adapter-wiring`   | **The only place adapters are instantiated**; registers each one only if its own env vars are set.               | adapters               |
| `@vd/db`               | Drizzle schema, client, migrations, health check.                                                                | core, config           |
| `@vd/pipeline`         | Platform-agnostic ingestion: normalize → identity → creator/video upsert → sighting → snapshot → run stats.      | contract, db           |
| `@vd/worker` (app)     | pg-boss runtime: queues, handler registration.                                                                   | wiring, db             |
| `@vd/cli` (app)        | `health`, `config-check`, `db-check`, `adapters`, `discover`, `submit-url`, `refresh-metrics`.                   | wiring, pipeline       |

Rule: **core and the pipeline never import an adapter, and nothing but
`@vd/adapter-wiring` instantiates adapters** (the worker and CLI both call it). Adding
or removing a source is a new package plus one entry there. The pipeline contains no
`if (platform === …)` branches.

## Source ≠ canonical platform

Two different things, never conflated:

- **Canonical platform** — where the video lives: `videos.platform` + `videos.platform_video_id`
  (unique) + `videos.canonical_url`.
- **Source** — where we observed it: `sightings.source_id` → `sources.adapter_id`, with the
  observation's details in `sightings.context`.

| Example                                | `videos.platform` | sighting source                                  |
| -------------------------------------- | ----------------- | ------------------------------------------------ |
| YouTube Short found via YouTube chart  | youtube           | youtube                                          |
| YouTube video linked in a Bluesky post | youtube           | bluesky (post URI, author, timestamp in context) |
| Native Twitch clip                     | twitch            | twitch                                           |
| TikTok URL pasted by a human           | tiktok            | manual-url                                       |
| Native Bluesky video                   | bluesky           | bluesky                                          |

An adapter declares `referencePlatforms` in its manifest (Bluesky and manual-url: youtube,
tiktok, twitch). `safeNormalize()` accepts a normalized video on another platform only if
it is declared, and only with `metrics: null`. The pipeline derives **authority**
generically — `normalized.platform === adapter.manifest.platform`:

- **Authoritative** observations update the video (non-null values win), store the raw
  payload, set availability, and write a metric snapshot.
- **References** only fill fields that are still null, never overwrite canonical data,
  never set availability (except from `unknown`), and never write metric snapshots —
  engagement on a post that links a video is not the video's engagement (it is kept in
  `sightings.context.postEngagement`).

## Ingestion semantics

- **Videos are idempotent:** `(platform, platform_video_id)` upsert. Re-running discovery or
  seeing the video via another source never duplicates it.
- **One sighting per observation per run:** unique `(discovery_run_id, video_id,
observation_key)`. `observation_key` defaults to the raw item's external id; adapters
  set it where one run can observe a video several ways (YouTube: `mostPopular:<region>:<category>`;
  Bluesky: the post URI). Retrying a run cannot duplicate sightings; a **new run adds new
  sightings** — presence over time (chart position, new posts) is evidence for scoring.
- **One metric snapshot per video per run**, unique `(video_id, captured_at)`.
- **Runs record evidence:** `discovery_runs.request` (adapter, kind, params, filters) and
  `discovery_runs.stats` (ingested, updated, sightings, snapshots, filtered + samples,
  quarantined + samples, quota used). Status: `succeeded`, `partial` (error or budget
  exhausted after some items), `failed`.
- **Filters run after normalization** (e.g. `maxDurationMs`), so filtered candidates are
  recorded, not lost. Unknown durations are kept and counted.
- **Quota:** each run's budget = `sources.daily_quota_budgets` − today's `api_usage`;
  adapters call `consumeQuota()` before every metered request. New sources get the
  manifest's verified defaults.
- **Refresh:** `refresh-metrics <platform>` uses the platform's adapter with
  `metrics.refresh` on all stored videos of that platform (least recently refreshed first),
  including videos first seen through other sources. Velocity = difference between snapshots
  (computed in the scoring phase, not now).
- **Enrichment:** `submit-url` records the submission as a `manual-url` reference, then, if
  the canonical platform's adapter is configured, fetches authoritative data (no extra sighting).

## Adapter contract

An adapter exposes a **manifest** (id, platform, version, access method, declared
capabilities, metrics it can actually provide, quota buckets, required env var
names, compliance-doc path) and implements one method per declared capability:

| Capability             | Method                              | Serves `SourceQuery.kind`              |
| ---------------------- | ----------------------------------- | -------------------------------------- |
| `discovery.search`     | `discoverSearch()`                  | `search`                               |
| `discovery.trending`   | `discoverTrending()`                | `trending`                             |
| `discovery.feed`       | `discoverFeed()`                    | `channel_feed`, `community_feed`       |
| `discovery.url`        | `lookupUrl()`                       | manual URL submission, link resolution |
| `metrics.refresh`      | `refreshMetrics()`                  | —                                      |
| `creator.enrich`       | `enrichCreator()`                   | —                                      |
| `normalize` (required) | `normalize()` — pure, deterministic | —                                      |

`checkAdapter()` enforces that declared capabilities and implemented methods match
exactly; `AdapterRegistry.register()` refuses non-compliant adapters. Every real
adapter must pass `describeAdapterContract()` (from `@vd/adapter-contract/testing`)
against **recorded** fixtures of real API responses.

**Quota is per bucket.** Platforms may meter methods separately (YouTube has done so
since 2026-06-01 — see `docs/sources/youtube.md`), so adapters consume from named
buckets and budgets live in `sources.daily_quota_budgets`, not in code.

**Configuration is per adapter.** Every adapter's env vars are optional in `@vd/config`;
`@vd/adapter-wiring` registers an adapter only when its `requiredEnv` is present and
reports the rest as unconfigured (names only, never values). Bluesky and manual-url need
no credentials, so discovery and URL submission work with only `DATABASE_URL`.

**HTTP:** adapters use `requestJson()` from the contract: typed `UpstreamError`s
(`rate_limited`, `quota_exceeded`, `unauthorized`, `not_found`, …), timeouts, and error
messages that contain only scheme/host/path — never query strings or credentials.
Adapters accept an injected `fetch` so tests never touch the network.

## Unavailable metrics

Metrics are never faked. Each reading is either `{kind: 'value'}` or
`{kind: 'unavailable', reason}` with reason one of `not_provided_by_platform`,
`hidden_by_owner`, `not_requested`, `unknown`. In the database the metric column is
`NULL` and `metric_snapshots.unavailable` records the reason. `safeNormalize()`
rejects an adapter that reports a value for a metric its manifest doesn't declare.
Scores record `missing_metrics` so scoring can down-weight rather than guess.

## Content origin vs rights

Two separate concepts, deliberately:

- **`videos.content_origin`** — how the content entered the system:
  `discovered_external` · `owned_original` · `licensed` · `ai_generated`.
  (`ai_generated` exists only to prevent ambiguity; no generation tool is integrated.)
- **`rights`** — permission to reuse/republish, per cluster, with history:
  `unknown` · `requested` · `granted` · `denied` · `own_content`, plus holder,
  contact, license terms, evidence URL, and expiry. A record may pin the exact upload
  the grant refers to (`rights.video_id`), because a grant from a reposter is not a grant.

Discovery never implies permission. Any future reuse feature must check `rights`.

## Jobs and scheduling

pg-boss (in its own schema in the same Postgres). The worker idempotently creates
the five pipeline queues on boot — `discover-source`, `normalize-item`,
`refresh-metrics`, `score-video`, `classify-cluster` — and still registers **no handlers**:
Phase 2 runs discovery from the CLI. Wiring `discover-source` / `refresh-metrics`
handlers to `@vd/pipeline` is a small follow-up. Payloads are validated with the Zod schemas in `@vd/core` before any
handler runs. No schedules are created. The worker starts cleanly with zero
adapters, zero sources, and zero schedules, and warns about enabled sources whose
adapter isn't registered.

## Data retention (design constraint, not yet implemented)

Platform terms constrain how long we may keep data (see each source doc). This is
why `videos.raw_payload` is isolated with `raw_payload_fetched_at`,
`videos.availability` exists, and review/rights hang off clusters rather than raw
payloads. A retention/deletion job is required **before** any source goes to
production use.

## Future: compilation planner (optional, NOT implemented)

An optional downstream feature that takes a few reviewed clips and **plans** one
original short-form video around them: groups compatible clips by theme, suggests
3–5 clips and an order, proposes a hook, commentary/reaction beats between clips,
and a title/caption — carrying each clip's source URL, creator attribution, virality
score, and **rights status / usage basis** through to the plan.

Design commitments made now so it can be added later without schema rework:

- Input is `clusters` with `review_events` + `rights` — both exist today.
- A plan references clips by cluster/video id and canonical URL; it never fetches media.
- A plan must surface any clip whose rights status is not `granted`/`own_content`
  (or whose basis is otherwise undocumented) instead of hiding it.
- It must work with no generative-video tool. Generation may be added someday or
  never; nothing in this architecture depends on it.

No tables, jobs, or code for the planner exist yet.

## Out of scope (by design)

Downloading/ripping third-party video · extracting media URLs (e.g. Bluesky HLS
playlists are never stored) · bypassing auth, anti-bot, DRM, paywalls · unofficial
scraping (TikTok pages, Reddit, `bsky.app` HTML) · following TikTok short-link redirects ·
publishing (later phase, separate service) · any specific AI-generation provider ·
scoring and classification (next phase).

## Decisions (Phase 1)

1. **Postgres-only infra.** pg-boss instead of Redis-based queues: one datastore to run.
2. **TypeScript source is the runtime artifact.** Workspace packages export `.ts`;
   apps run via `tsx`. No build step yet. Revisit (tsup/tsc emit) before production deploy.
3. **TypeScript pinned to 6.0.x.** TS 7 is the current npm `latest`, but
   typescript-eslint 8.70 supports `<6.1.0`; type-aware linting was kept over the newer compiler.
4. **Platform is an open string**, not a DB enum, so adapters can be added without migrations.
5. **Enum values are defined once** (`as const` tuples in `@vd/core`) and feed both Zod and Drizzle.
6. **Rights are a history table per cluster**, optionally pinned to a specific upload.
7. **Minimal indexes**: uniqueness + FK lookups only; add more from real query plans.
8. **Node ≥ 22.9.0.** Scripts use `node --env-file-if-exists` (added in v22.9.0) with
   `--import tsx`. `.nvmrc` stays at `22`.

## Decisions (Phase 2)

1. **Source ≠ canonical platform** via manifest `referencePlatforms` + derived authority;
   no parallel "linked video" model — Video + Sighting carry it.
2. **References never carry metrics** (enforced in `safeNormalize()` and again in the pipeline).
3. **Sightings are per run** (unique run × video × observation key); videos are global.
4. **URL identity is a pure package** shared by adapters; unknown URLs are rejected, not guessed.
5. **Filters apply after normalization** and are recorded on the run.
6. **Per-adapter configuration**: missing credentials disable one adapter, never the system.
7. **Pipeline tests run on PGlite** (in-process Postgres, test-only dependency) with the
   real migrations, so dedupe/upsert semantics are tested on Postgres without a server.
8. **Fixtures are synthetic** but shaped exactly like the documented responses (no
   credentials were available to record YouTube/Twitch). Live tests exist behind `LIVE_API_TESTS=1`.
