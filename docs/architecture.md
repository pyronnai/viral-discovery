# Architecture

_Status: Phase 3 (breakout discovery + virality scoring v1). Last updated 2026-09-29._

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

| Stage                | Responsibility                                                                                                                                                                               | Status (Phase 2)                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Source adapters**  | Talk to one platform via an approved access method; yield `RawItem`s.                                                                                                                        | YouTube, Twitch, Bluesky, manual URL (+TikTok oEmbed). Reddit planned.         |
| **Ingestion**        | Run a `SourceQuery` through its adapter, record a `DiscoveryRun`, persist `Sighting`s, account quota in `api_usage`.                                                                         | `@vd/pipeline` `runDiscovery` / `runSourceQuery`, via CLI.                     |
| **Normalization**    | `adapter.normalize(raw)` → `NormalizedVideo`, validated by `safeNormalize()` at the boundary. Invalid items are quarantined (counted + sampled on the run), never silently dropped.          | Implemented.                                                                   |
| **Identity**         | Map URLs/ids to the canonical `(platform, platform_video_id)` + canonical URL.                                                                                                               | `@vd/url-identity` (pure) + `@vd/url-resolution` (TikTok short links).         |
| **Enrichment**       | Fill a referenced video from its canonical platform's adapter (`discovery.url`).                                                                                                             | For `submit-url` only. `creator.enrich` not implemented.                       |
| **Deduplication**    | Exact: `(platform, platform_video_id)` unique. Near-duplicate: cluster by thumbnail hash + duration + title similarity into `clusters`. Review status is per cluster, so reposts inherit it. | Exact dedupe implemented. Clustering not implemented.                          |
| **Metric snapshots** | Time series of engagement readings. Every metric is explicitly a value or unavailable-with-reason.                                                                                           | Initial snapshot on ingest + refresh ladder (`refresh-metrics --due`, `tick`). |
| **Scoring**          | Velocity/engagement/outlier/freshness score, per-platform normalized, **versioned** (`scores.algorithm_version`).                                                                            | `@vd/scoring` breakout-v1 + `rescore` / `score-video` job.                     |
| **Classification**   | Multi-label categories + safety flags, **versioned** by taxonomy, model, and prompt.                                                                                                         | Table only. Not implemented.                                                   |
| **Review**           | Human decisions (`approved`, `rejected`, `saved`, `already_used`) as an append-only event log per cluster.                                                                                   | Table. No UI.                                                                  |

## Packages

| Package                | Role                                                                                                                | Depends on             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `@vd/config`           | Zod-validated env (adapter credentials optional), Pino logger factory.                                              | —                      |
| `@vd/core`             | Storage-agnostic domain types, enums, metric model, job contracts.                                                  | —                      |
| `@vd/url-identity`     | Pure URL → canonical identity for YouTube, TikTok, Twitch clips. No network, never guesses.                         | —                      |
| `@vd/url-resolution`   | Network step above it: allowlisted, bounded expansion of TikTok short links (no generic redirect following).        | url-identity           |
| `@vd/scoring`          | Pure, deterministic breakout score v1 (components, confidence, explanation, evidence fingerprint). No DB, no clock. | core                   |
| `@vd/adapter-contract` | `SourceAdapter` interface, manifest, normalized schemas, quota budget, registry, HTTP helper, contract test kit.    | core, config           |
| `@vd/adapter-*`        | `youtube`, `twitch`, `bluesky`, `manual-url`: one platform/access method each.                                      | contract, url-identity |
| `@vd/adapter-wiring`   | **The only place adapters are instantiated**; registers each one only if its own env vars are set.                  | adapters               |
| `@vd/db`               | Drizzle schema, client, migrations, health check.                                                                   | core, config           |
| `@vd/pipeline`         | Platform-agnostic ingestion: normalize → identity → creator/video upsert → sighting → snapshot → run stats.         | contract, db           |
| `@vd/worker` (app)     | pg-boss runtime: queues, handler registration.                                                                      | wiring, db             |
| `@vd/cli` (app)        | `health`, `config-check`, `db-check`, `adapters`, `discover`, `submit-url`, `refresh-metrics`.                      | wiring, pipeline       |

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

## Candidate discovery strategies (Phase 3)

Discovery is **configuration, not code**: `source_queries` rows (kind, params, region,
`cadence_minutes`, enabled) managed with `vd queries add|list|enable|disable`. The existing
model is sufficient for every source — no new query table was needed:

| Query                   | Adapter | kind           | Example params                                                       |
| ----------------------- | ------- | -------------- | -------------------------------------------------------------------- |
| YouTube chart           | youtube | `trending`     | `regionCode: ["US","GB"]`, `videoCategoryId`                         |
| YouTube targeted search | youtube | `search`       | `q: "funny animals"`, `publishedWithinHours: 48`, `order: viewCount` |
| YouTube seed channels   | youtube | `channel_feed` | `channelId: [...]` / `handle` / `uploadsPlaylistId`, `maxPerChannel` |
| Twitch game clips       | twitch  | `trending`     | `gameId`, `lookbackHours`                                            |
| Twitch broadcaster      | twitch  | `channel_feed` | `broadcasterId`                                                      |
| Bluesky search          | bluesky | `search`       | `q`, `domain: "tiktok.com"`, `tag`                                   |

Search themes (funny, fails, animals, reaction, …) are one query each, so each has its own
cadence and cost; nothing is hard-coded in adapters. `discover-due` runs enabled queries
whose cadence elapsed (`discovery_runs.created_at` uses the pipeline clock).
Note: `channel_feed` and `community_feed` share the `discovery.feed` capability; adapters
reject the kind they do not serve.

### YouTube search quota strategy

- **API fact (2026-09-29):** `search.list` costs 1 unit in its own _Search Queries_ bucket,
  **100 calls/day** by default; `videos.list`, `channels.list`, `playlistItems.list` cost
  1 unit each from the default 10,000-unit bucket; `videoDuration=short` means **< 4 minutes**
  (it is not a Shorts detector).
- **Application choices:** one search page = 1 `search.list` call + 1 `videos.list` call for
  metadata/stats. The source budget for `search.list` defaults to the manifest's 100; a
  source row that predates the bucket still gets the manifest default (never "unlimited").
  With e.g. 10 themes × every 6 h × 1 page = 40 calls/day, well under 100. Seed channels
  cost no search quota (`channels.list` once per run + `playlistItems.list` per channel +
  `videos.list` per 50 uploads), and a `publishedWithinHours` window skips old uploads
  before spending `videos.list` quota.

### TikTok short links

See `docs/sources/tiktok.md`. `@vd/url-identity` stays pure; `@vd/url-resolution` expands
allowlisted TikTok short links with bounded HEAD redirects and never fetches video pages.

## Metric refresh lifecycle

- **T0** = a video's first canonical snapshot (or first discovery if it has none, e.g. a
  YouTube video first seen via Bluesky).
- **Ladder** (default, configurable): T0 + 2 h, 8 h, 24 h, 72 h. A step is satisfied by any
  snapshot at ≥ step × (1 − tolerance 0.2). Missed steps collapse into the latest one (one
  refresh, not a backlog). After the last step + 6 h grace the video **ages out**.
- **Configuration:** `sources.config.refreshPolicy` of the refreshing source
  (`{ladderMinutes, tolerance, graceMinutes}`), overridable with `--ladder 2h,8h,24h,72h`.
- **Bulk:** due videos are refreshed together through the adapter's bulk method (YouTube
  `videos:batchGetStats` in application batches of `YOUTUBE_STATS_BATCH_SIZE`, default 50 —
  **YouTube documents no maximum**; Twitch Get Clips ≤ 100 ids; Bluesky `getPosts` ≤ 25).
- Platforms without canonical metrics (TikTok via oEmbed) are never refreshed; nothing is fabricated.

## Virality / breakout scoring v1 (`breakout-v1`)

Goal: _which candidates are breaking out unusually fast for their age and context_ — not
"most total views". Pure and deterministic (`@vd/scoring`), no LLM, no clock inside.

```
score = 100 × weightedMean(available components) × (0.5 + 0.5 × confidence)
```

Only **available** components enter the mean (weights renormalized), so a platform is never
punished for a metric it does not expose. Low evidence dampens the score.

| Component         | Weight | Basis              | Definition (all values 0–1)                                                                                                                                                                                                        |
| ----------------- | ------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| velocity          | 0.30   | canonical          | growth metric (views, else likes) between the latest snapshot and the latest one ≥ 30 min earlier: 0.6 × absolute (log10(1+Δ/h), platform percentile or fallback scale) + 0.4 × relative (Δ ÷ previous count per hour; 50 %/h → 1) |
| acceleration      | 0.10   | canonical          | needs 3 spaced snapshots: later ÷ earlier velocity, 0.5 + log2(ratio)/4 (×4 → 1, flat → 0.5, ×¼ → 0)                                                                                                                               |
| engagement        | 0.15   | canonical          | mean over **supplied** likes/comments/shares ÷ views (≥ 100 views), percentile or reference (5 % / 0.5 % / 0.5 %)                                                                                                                  |
| freshness         | 0.15   | canonical          | 0.5^(age h / 36); age from `published_at`, else `first_discovered_at` (flagged, lower confidence)                                                                                                                                  |
| crossSource       | 0.10   | discovery          | 0.6 × min(1, (distinct sources − 1)/2) + 0.4 × min(1, log2(independent observations)/4)                                                                                                                                            |
| sourcePropagation | 0.10   | source_propagation | log10(1 + Σ likes+reposts+replies+quotes of discovery-source items) / log10(1001); latest observation per item                                                                                                                     |
| creatorOutlier    | 0.10   | canonical          | log10(current ÷ creator median) / log10(20); needs ≥ 5 other videos by the creator                                                                                                                                                 |

### Missing-data behavior

- Missing metrics are `unavailable` with a reason, never zero. `missing_metrics` is stored.
- No views → likes become the growth metric (`NO_VIEW_METRIC`), engagement unavailable.
- One snapshot → no velocity (`SINGLE_SNAPSHOT`); snapshots < 30 min apart → `SNAPSHOTS_TOO_CLOSE`.
- < 3 spaced snapshots → no acceleration. Decreasing counts → Δ = 0 (`METRIC_DECREASED`).
- Creator baseline with < 5 other videos → unavailable (`CREATOR_BASELINE_UNAVAILABLE`); it
  strengthens automatically as the dataset grows.

### Confidence states

| State                   | When                                               | `value`                      |
| ----------------------- | -------------------------------------------------- | ---------------------------- |
| `scored`                | velocity measured (≥ 2 spaced canonical snapshots) | 0–100                        |
| `provisional`           | canonical metrics exist, velocity not yet          | 0–100, dampened              |
| `insufficient_evidence` | no canonical metrics (e.g. manual TikTok)          | **NULL** (DB check enforces) |

Confidence (0–1): 0.3 provisional / 0.6 velocity / 0.75 + acceleration; +0.1 platform-percentile
velocity; +0.05 real publish time; +0.05 engagement available; +0.05 ≥ 2 sources. Insufficient: 0.
Components are still computed and stored for insufficient-evidence candidates (e.g. "seen in
5 Bluesky posts") so a review feed can show them honestly.

### Platform normalization

Velocity (log growth/hour, per growth metric) and engagement ratios are converted to a
**mid-rank percentile within the platform** over the latest `breakout-v1` score of every other
video on that platform in the last 14 days — once that sample has ≥ 30 values. Below that,
a documented **absolute fallback scale** is used, the component is labeled
`normalization: absolute_fallback`, `VELOCITY_NORMALIZATION_FALLBACK` is emitted, and confidence
is 0.1 lower. Raw counts are never compared across platforms.

### Canonical metrics vs source-context engagement

- Canonical metrics come only from the video's own platform (metric snapshots).
- A discovery source's own engagement (Bluesky post likes/reposts/replies/quotes, stored as
  `sightings.context.postEngagement`) feeds **only** `sourcePropagation`, basis
  `source_propagation`, and only from sightings whose source platform differs from the video's
  (a native Bluesky video's post _is_ the video — no double counting).
- Cross-source counts **independent observations** = distinct (source, observation key), so
  repeat runs and duplicate sightings in a run cannot inflate it.

### Score lifecycle

- `scores` rows: `value`, `state`, `confidence`, `components` (per-component availability,
  value, strength, basis, normalization, details), `missing_metrics`, `reason_codes`,
  `algorithm_version`, `inputs_hash`, `based_on_snapshot_id`, `computed_at` (= asOf).
- **Eligibility:** `rescore` (default scope `stale`) selects videos with no score for the
  current version, or with a snapshot/sighting newer than their latest score. Other scopes:
  `--unscored`, `--recent <h>`, `--video <ids>`, `--platform`.
- **Idempotent:** the evidence fingerprint (config + snapshots + sightings + creator history,
  excluding clock and population) is compared with the latest score; identical evidence
  stores nothing. Scoring ignores evidence after `asOf`, so recalculation is reproducible.
- **Versioning:** every tunable lives in `ScoringConfig`; changing one requires a new
  `version`. Scores of different versions are never mixed in populations.

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

pg-boss (in its own schema in the same Postgres). The worker idempotently creates the
five queues on boot and, since Phase 3, registers handlers for three of them:

| Job               | Handler                                        | Idempotency                                              |
| ----------------- | ---------------------------------------------- | -------------------------------------------------------- |
| `discover-source` | `runSourceQuery` for the stored query          | videos upsert; sightings unique per run                  |
| `refresh-metrics` | `refreshMetrics` grouped by canonical platform | snapshots unique per (video, captured_at)                |
| `score-video`     | `scoreVideo` (current algorithm only)          | a row is stored only if the evidence fingerprint changed |

`normalize-item` and `classify-cluster` stay handler-less. The worker still creates **no
pg-boss schedules**: `pnpm cli tick` (cron-friendly) runs one pass of
`discover-due` → `refresh-metrics --due` (every platform with a `metrics.refresh`
adapter) → `rescore` (stale only).

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
LLM classification, dashboard, compilation planning (later phases).

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

## Decisions (Phase 3)

1. **TikTok short links** are expanded by a separate network layer with a host allowlist and
   bounded HEAD redirects; the identity package stays pure.
2. **YouTube discovery = chart + targeted search + seed channels**, all as SourceQuery data.
3. **Refresh ladder** from T0 with tolerance and age-out; bulk refresh per platform.
4. **Breakout score v1** is a renormalized weighted mean of available components with
   evidence dampening; three explicit states; NULL value without canonical evidence.
5. **Source propagation is its own component**, never merged into canonical engagement.
6. **Percentile normalization per platform** only with ≥ 30 samples; otherwise a labeled fallback.
7. **Idempotent scoring** via evidence fingerprints; the worker handles `discover-source`,
   `refresh-metrics`, `score-video`; `tick` is the cron entry point (no pg-boss schedules yet).
