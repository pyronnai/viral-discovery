# Architecture

_Status: Phase 5 (daily viral-video inbox). Last updated 2026-10-01._

## Purpose

**A multi-source viral-video discovery and review inbox.** It discovers public
short-form videos through permitted access methods, tracks their engagement over time,
scores, classifies and deduplicates them, and presents the strongest candidates as a daily
inbox the operator triages: save, open the original, track what was obtained and already used.

**Current scope:** the system finds and prioritizes candidate content. The operator does
editing, compilation structure, captions/hooks and publishing **externally**. Compilation
planning, script/hook generation, editing and publishing are not part of the product (see
"Out of scope").

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
| **Deduplication**    | Exact: `(platform, platform_video_id)` unique. Near-duplicate: cluster by thumbnail hash + duration + title similarity into `clusters`. Review status is per cluster, so reposts inherit it. | Exact + near-duplicate clustering (Phase 4.5).                                 |
| **Metric snapshots** | Time series of engagement readings. Every metric is explicitly a value or unavailable-with-reason.                                                                                           | Initial snapshot on ingest + refresh ladder (`refresh-metrics --due`, `tick`). |
| **Scoring**          | Velocity/engagement/outlier/freshness score, per-platform normalized, **versioned** (`scores.algorithm_version`).                                                                            | `@vd/scoring` breakout-v1.1 + `rescore` / `score-video` job.                   |
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
- **Enrichment:** a video seen only as a **reference** (a Bluesky post linking YouTube, a
  `submit-url` submission) is looked up on its canonical platform by that platform's adapter
  (`discovery.url`), if configured: reference → canonical identity → authoritative adapter →
  lookup → merge. The lookup is an authoritative observation (its non-null fields win; reference
  data only ever fills gaps), writes no sighting (the reference's sighting stays), may add a
  canonical metric snapshot, and is metered on that adapter's own quota. Discovery runs do this
  for references they touched that were never observed authoritatively (≤ 50 per run, counted in
  `stats.enrichment`); `enrich-references` backfills older rows. Without a configured adapter the
  reference keeps its reference data. `api_usage` records units **and** metered requests per bucket.
- **Source moderation ≠ AI analysis:** adapters may report the platform's own moderation labels
  (`videos.source_moderation_labels`: verbatim value, labeler, content/account scope,
  self-applied, and whether the platform defines it as explicit adult/graphic content). Bluesky:
  post labels, record self-labels and account labels (not profile-record labels; negated and
  expired labels dropped); explicit = `porn`, `sexual`, `nudity`, `graphic-media`. Labels are
  refreshed with metrics (labelers often act after first discovery); references never carry
  them. Explicitly labelled clusters are excluded from Viral Now, kept in All/Flagged and shown
  with a warning. Unlabelled content is never guessed at — that needs the AI classifier.

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

## Virality / breakout scoring (`breakout-v2`, current)

Goal: _which videos are ALREADY performing exceptionally for their age, right now_ — useful from
the **first** authoritative snapshot. The refresh ladder (+2 h, +8 h, +24 h, +72 h) then validates
and corrects that estimate; it never gates visibility. Pure and deterministic (`@vd/scoring`,
`v2.ts`); `breakout-v1.1` rows are kept untouched and the inbox reads v2 only.

```
P  inferred pace   = norm(log10(1 + count ÷ max(age_at_snapshot, 1 h)))      platform scale
M  measured rate   = norm(log10(1 + growth/h between our snapshots))         same scale as P
β  observed share  = span ÷ (span + 2 h)          (0 with one snapshot; ≈0.5 at +2 h, ≈0.8 at +8 h)
F  age discount    = 1 for 24 h, then halves every 48 h        (inferred part only)
R  reach           = norm(log10(1 + current count))           per-platform audience scale

paceCore = (1 − β)·P·F + β·M
core     = paceCore^0.6 · R^0.4                                reach stays in the core
score    = 100 · softCap(core · trend · engagement · creator + propagationBonus)
```

- **Count** is views; platforms without views (Bluesky) use likes on their own scale. Fallback
  scales (log10 of [lo, hi] → [0, 1]): YouTube pace 10/h…50k/h, reach 100…1M; Twitch pace
  5/h…5k/h, reach 100…100k (a high audience bar: a few hundred clip views is a small sample, a
  clip with tens of thousands competes with the best YouTube videos); likes 1/h…1k/h, 10…10k.
- **Platform percentile**: once ≥ 30 v2 scores exist for a platform (14-day window), the
  percentile of log pace is blended in, weight rising smoothly from 0 to at most 50 % at 100 —
  the documented scale always keeps ≥ 50 %, so the best item of a weak pool is not "viral" by
  default.
- **Bounded modifiers**: trend ×(1 ± 0.15·β) from the measured rate vs the earlier rate (previous
  interval, or the lifetime pace at the earlier snapshot); engagement ×0.9–1.1 and creator
  outlier ×1.0–1.1 (v1.1's measurements, skipped when unavailable); propagation bonus ≤ +0.10
  (cross-source sightings, discovery-source engagement). `softCap` is the identity up to 0.8
  and approaches 1 smoothly above it, so strong candidates stay ordered instead of tying at 100.
- **Confidence** (0.2 + 0.3·R + 0.35·β, + publish time known, + percentile backing) is shown,
  never multiplied in: _provisional means less certain, not less viral_.
- **States**: `insufficient_evidence` (no score) — no canonical metric, reach < 0.1 without a
  measurement (e.g. 200 views at 10 min), or publish time unknown without a measurement (time
  since discovery would overstate pace); `provisional` — inferred pace only; `scored` — measured.
- **Time**: the age discount decays, so `next_rescore_at` schedules time-only rescoring until
  it reaches its floor (same lifecycle as v1.1).
- **Viral Now evidence** (stored in `components._meta.viralNow`): not insufficient, reach ≥ 0.1
  and score ≥ 30. **Revival**: measured velocity ≥ 0.6 with β ≥ 0.5, reach ≥ 0.1, and a rate at
  least the earlier rate (renewed momentum, not an ordinary long tail).

### Viral Now eligibility

Untriaged (no decision, not used/rejected) **and** no explicit platform moderation label **and**
v2 viral evidence **and** published (else discovered) within the window — default **48 h**,
`VIRAL_NOW_HOURS` in the web app, `viralNowHours` per query — **or** a measured revival whose
latest snapshot is within the window. Sorted by score (any state with a value first).

## Virality / breakout scoring (`breakout-v1.1`, historical)

_Superseded by breakout-v2 (its rows stay in `scores`; v2 reuses its engagement, propagation
and creator-outlier measurements). v1.1 (Phase 3.1) changed only evidence selection and aging — manual submissions excluded from
propagation, age-matched creator outlier, time-based staleness. Weights and fallback constants
are unchanged and still uncalibrated._

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
| crossSource       | 0.10   | discovery          | **public propagation sightings only**: 0.6 × min(1, (distinct public sources − 1)/2) + 0.4 × min(1, log2(independent public observations)/4)                                                                                       |
| sourcePropagation | 0.10   | source_propagation | log10(1 + Σ likes+reposts+replies+quotes of discovery-source items) / log10(1001); latest observation per item                                                                                                                     |
| creatorOutlier    | 0.10   | canonical          | **age-matched**: current ÷ median of the creator's other videos at ≈ the same age since publish; log10(ratio)/log10(20); needs ≥ 5 age-matched videos                                                                              |

### Missing-data behavior

- Missing metrics are `unavailable` with a reason, never zero. `missing_metrics` is stored.
- No views → likes become the growth metric (`NO_VIEW_METRIC`), engagement unavailable.
- One snapshot → no velocity (`SINGLE_SNAPSHOT`); snapshots < 30 min apart → `SNAPSHOTS_TOO_CLOSE`.
- < 3 spaced snapshots → no acceleration. Decreasing counts → Δ = 0 (`METRIC_DECREASED`).
- Creator outlier needs real publish times (candidate and history) and ≥ 5 other videos with a
  reading near the candidate's age; otherwise unavailable with the exact reason
  (`CREATOR_BASELINE_UNAVAILABLE`). It never falls back to comparing different ages.

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
**mid-rank percentile within the platform** over the latest score (same algorithm version) of every other
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

### Public propagation vs non-propagation observations

Each adapter declares `manifest.sightingRole`:

- `propagation` (YouTube, Twitch, Bluesky): the video was observed on the public internet —
  evidence that it spreads.
- `provenance` (`manual-url`): how the video entered the system (a human pasted it). The
  sighting is stored, keeps provenance, enables lookup/enrichment and review, but is
  **excluded** from `crossSource`, `sourcePropagation`, the ≥ 2-sources confidence bonus,
  and `CROSS_SOURCE_n` reason codes. Unknown adapters are treated as `provenance`.

The pipeline maps adapter → role from manifests (`@vd/adapter-wiring` → `adapterSightingRoles`);
the scorer only sees `role` on each sighting — no source-name comparisons. Every score exposes
`observations: { publicPropagation: [{source, observations}], nonPropagation: [...] }`
(stored in `components._meta.observations`, shown by `rescore --explain`), plus reason code
`NON_PROPAGATION_OBSERVATIONS`. A manual-only video has `crossSource` = 0 (available), not
"unavailable", so it gains nothing from having no public sightings.

### Creator outlier: age matching

- Target age = latest candidate reading − candidate `published_at`.
- For each of the creator's other videos **with a publish time**, take the **nearest** snapshot
  whose age since publish is within ± max(1 h, 25 % × target age) (configurable:
  `creatorAgeWindowMinHours`, `creatorAgeWindowRatio`). No interpolation.
- Baseline = median of the matched readings; requires ≥ 5 matched videos. Details expose
  `targetAgeHours`, `windowHours`, `creatorVideos`, `withPublishTime`, `ageMatched`, `matched`.

### Time-based staleness

Freshness (half-life 36 h) decays even without new evidence. Each score stores
`next_rescore_at` = the instant freshness will have dropped by `freshnessRescoreDelta` (0.05),
or reaches the `freshnessRescoreFloor` (0.05, ≈ 6.5 days old). Below the floor, and for
`insufficient_evidence`, it is NULL: only new evidence triggers rescoring, so old videos age
out. The `stale` scope (used by `rescore` and `tick`) selects videos with new evidence **or**
whose latest score is time-due. A same-evidence rescore stores a new row only when time-due,
so repeated scheduler runs before the due time are no-ops. Cadence follows the freshness curve:
roughly every 3–4 h for a 1-day-old video, less often as it ages, then never.

### Score lifecycle

- `scores` rows: `value`, `state`, `confidence`, `components` (per-component availability,
  value, strength, basis, normalization, details), `missing_metrics`, `reason_codes`,
  `algorithm_version`, `inputs_hash`, `based_on_snapshot_id`, `computed_at` (= asOf),
  `next_rescore_at` (time-based staleness).
- **Eligibility:** `rescore` (default scope `stale`) selects videos with no score for the
  current version, or with a snapshot/sighting newer than their latest score. Other scopes:
  `--unscored`, `--recent <h>`, `--video <ids>`, `--platform`.
- **Idempotent:** the evidence fingerprint (config + snapshots + sightings + creator history,
  excluding clock and population) is compared with the latest score; identical evidence
  stores nothing. Scoring ignores evidence after `asOf`, so recalculation is reproducible.
- **Versioning:** every tunable lives in `ScoringConfig`; changing one requires a new
  `version`. Scores of different versions are never mixed in populations.

## Content understanding (Phase 4)

Two separate questions, never mixed:

|                    | Virality score (`@vd/scoring`)                         | Content analysis (`@vd/classification`)                                                         |
| ------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Question           | How strongly does the **data** show breakout behavior? | **What** is this, and why might it appeal?                                                      |
| Method             | Deterministic formula over metrics and sightings       | Model-generated (LLM) from metadata + thumbnail                                                 |
| Nature             | Measurement (with confidence/state)                    | **Hypotheses / interpretations**, labeled "AI content analysis"                                 |
| Affects the other? | No                                                     | No — classification never changes the score, and a score change never triggers reclassification |

### Pipeline

`classify --eligible` / `classify-cluster` job → build input from stored data → provider →
Zod validation → store (or quarantine) → dashboard.

- **Unit:** the cluster (via its representative video). A cluster may hold several confirmed
  representations (see "Identity: exact vs near-duplicate").
- **Inputs (permitted only):** platform, canonical URL, title, caption, duration, publish
  time, creator display name/handle, short discovery-context descriptors (e.g.
  `bluesky: search "funny"`), and the thumbnail **URL**, which the provider fetches itself.
  No video download, no frame extraction, no media proxying. If the provider cannot use
  the thumbnail, classification retries text-only and records `inputsUsed.thumbnail =
"unavailable"`; `"none"` when no HTTPS thumbnail exists.
- **Output** (validated with Zod, schema-constrained generation where supported):
  `summary`, multi-label `labels[{label, confidence}]`, `safetyFlags[{flag, confidence,
note}]`, and `analysis` (hook, setup, payoff, emotionalDriver, novelty, pacingNotes,
  audienceAppeal, reusableFormat, suggestedTheme, whyItMayWork — each nullable).
- **Invalid output** (schema or product rules: unknown label, no labels, duplicates,
  "other" mixed with specific labels, confidence outside 0–1) is **never stored** as a
  classification; the attempt is recorded in `classification_failures` (kind, message,
  details — no raw model response). Refusals and truncation are distinct kinds.

### Taxonomy (`content-taxonomy-v1`) and prompt (`content-prompt-v1`)

Labels (multi-label): funny, fails, animals, reactions, memes, unexpected, wholesome, prank,
gaming, sports, other. Review flags: serious_injury, violence, minors, sexual_or_nsfw,
tragedy_or_death, dangerous_behavior, potentially_distressing. Flags describe cues for a
human reviewer; the prompt forbids claims about legality or the identity/character of real
people. **Flagged candidates are never removed** — the dashboard highlights significant
flags. Changing labels/definitions bumps the taxonomy version; changing the prompt bumps
the prompt version; either makes every cluster eligible for reclassification.

### Provider abstraction

`ContentClassifier { provider, model, classify(input) }`. Providers are thin transports;
a shared layer (`classifierFromTransport`) owns thumbnail→text fallback, refusal/truncation
handling, and validation, so every provider behaves identically. Stored rows are
provider-neutral: `provider`, `model` (the model that actually answered), `taxonomy_version`,
`prompt_version`, `created_at` (classified at), `inputs_used`, `input_hash`.

- **Anthropic** (first implementation): Messages API with structured output
  (`output_config.format` JSON schema from the Zod schema), `effort: low`, server-side
  refusal fallbacks (`fallbacks: "default"`), stable cached system prompt, typed SDK errors
  mapped to `rate_limited` / `provider_error` (retryable or not). Default model
  `claude-opus-5-5` (`CLASSIFIER_MODEL` to change).
- **Fake** (tests/local): deterministic, same shared layer.
- **Unconfigured:** `createClassifier()` returns a reason, never a stand-in. The dashboard
  shows "Unclassified"; `classify` fails clearly; the worker job completes as a no-op.

### Classification gate (don't spend calls on low-value candidates)

A cluster is **eligible** when (latest representative score for the current scoring version is
`scored`/`provisional` and ≥ `CLASSIFICATION_MIN_SCORE`, default 60) **or** its current review
status is `saved`/`approved`; **and** it has no classification for the current
taxonomy + prompt + input fingerprint; **and** fewer than 3 failures for that same input.
`--cluster/--video` (and the dashboard's Classify/Reclassify) classify explicitly; `--force`
ignores the idempotency check. Insufficient-evidence candidates are only classified on
request or when saved/approved.

## Daily viral-video inbox (Phase 5)

The dashboard's main page is an inbox over clusters (one item per underlying clip; confirmed
reposts are shown as "Also on" representations of that item, never as separate items).

**Views** (`?view=`, `@vd/review` `INBOX_VIEWS`):

| View              | Shows                                                                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `viral` (default) | **Viral Now**: v2 viral evidence, published (else discovered) ≤ 48 h (configurable) or a recent measured revival, no current decision, never used/rejected, no explicit platform label |
| `unreviewed`      | no decision (any score state, incl. insufficient evidence)                                                                                                                             |
| `saved`           | the shortlist                                                                                                                                                                          |
| `obtained`        | obtained externally and **not yet used**                                                                                                                                               |
| `used`            | already used (history)                                                                                                                                                                 |
| `rejected`, `all` | as named                                                                                                                                                                               |

Ordering within Viral Now is the existing deterministic score (no new formula). **Sorts**
(`?sort=`): `virality` (score state, then score — platforms without view counts still rank via
their normalized components), `newest`, `growth` (the score's platform-normalized velocity
component), `views`, `discovered`. Missing values are never compared as zero — rows without
the value sort after rows with it — and every sort has its own keyset cursor.

**Workflow state** — three independent ideas, deliberately not conflated:

- **Saved** (`review_events.status = saved`): "I want this clip / come back to it". **Unsave**
  appends `cleared` (no current decision) — and only when the clip is currently saved, so it can
  never undo "already used" or "rejected".
- **Obtained** (`acquisition_events`, append-only, latest wins): the operator obtained the source
  media externally; `obtained_at` = that record's time, optional note and representation.
  Tracking only — nothing is downloaded — and it never implies "used" or "published".
- **Already used** (`review_events.status = already_used`): never surfaced as fresh again —
  excluded from Viral Now, Unreviewed and Obtained; kept in the Used history. On a cluster merge,
  "already used" **always wins** (it is a fact, not a judgment, so it is never a review conflict),
  and if the absorbed side's record is the used one, a `system` event re-asserts it on the
  survivor. "Obtained" carries over the same way. An _unconfirmed_ possible duplicate of used
  content stays separate but is flagged on its card.

**Source access vs media download.** Every candidate has a source link (canonical URL, plus each
confirmed representation). A **download** is shown only when a `media_assets` row exists — an
asset explicitly provided by an official/authorized API or rights holder (none of today's
adapters provide one; the table is the extension point). Player/CDN URLs are never extracted.

**Bulk actions** (`bulkApply`): save, obtained, used, reject on up to 200 selected clusters;
merged-away ids resolve to their survivor and collapse, each item is idempotent, failures are
reported per item. The UI confirms Used and Reject. **Export** (`/export?format=csv|json` with
`ids=` or the current view's filters): one row per clip with title, creator, platform, canonical
URL, alternate representation URLs, score, labels, duration, rights, review and obtained state —
metadata and links only; CSV cells are quoted and formula-prefixed values neutralized.

**Detail page** adds "Source & access" (creator/handle, platform, original URL, publication,
duration, latest metrics, labels, score, duplicate status, rights, media availability, all
representations) and "More from this creator" (≤ 6 other candidates by the same creator record
or platform + handle/name).

**Discovery health** (`/health`): per adapter (configured or not, with missing variable _names_)
and per source: state (healthy / stale > 24 h / failing / never run / disabled / unconfigured),
last success, runs/found/new in 24 h, quarantined items (`stats.invalid`), today's quota usage vs
budget, last error; plus pipeline freshness (last score, duplicate scan, classification). Planned
adapters (Reddit) are listed with the reason.

## Human review dashboard (Phase 4)

`apps/web` — Next.js 16 (App Router, React 19, Turbopack), **internal, single-user**. Pages are
server-rendered from Postgres via `@vd/review` (feed/detail queries, actions, presenters); it
needs only `DATABASE_URL` — no source-API or model credentials to render stored data.

| Route                     | What                                                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                       | **Inbox** (Phase 5): view tabs with counts (Viral Now default), category chips, filters/sort, bulk bar + export, cards (see "Daily viral-video inbox")                                                                                            |
| `/candidates/[clusterId]` | Detail: larger thumbnail, canonical metadata, Open original, score breakdown + history, metrics table + inline SVG growth chart, AI content analysis (+ Classify/Reclassify), rights (history + manual edit), review history, sightings with role |
| `/export`                 | CSV/JSON export of selected ids or the current view (Phase 5): metadata and links only                                                                                                                                                            |
| `/health`                 | Discovery health (Phase 5): per-adapter/source state, recent finds, quarantined, quota, last error                                                                                                                                                |
| `/login`                  | Only when `DASHBOARD_ACCESS_TOKEN` is set: a minimal access gate (`src/proxy.ts`), hashed httpOnly cookie, constant-time compare. Not a user system.                                                                                              |

- **Feed query:** one SQL statement per page over clusters (representative video) with
  `LATERAL` joins for the latest score (current algorithm), latest review event, latest rights
  record, latest classification + failure (current taxonomy/prompt), latest snapshot, version
  count, and per-source observation counts — no N+1; heavy histories load only on the detail page.
- **Ordering:** scored → provisional → insufficient evidence → not scored; then latest score
  (NULL never treated as zero), then recency (published, else first discovered), then id.
  **Keyset cursor** on exactly that order (malformed cursors fall back to page 1).
- **Filters (URL params, shareable):** `review` (incl. `unreviewed`), `label`, `platform`,
  `source`, `state` (incl. `unscored`), `minScore`, `within` (hours since discovery),
  `rights`, `flagged`. Unknown values are ignored.
- **Cards:** thumbnail (loaded straight from the platform CDN, `referrerPolicy=no-referrer`,
  broken images degrade to a placeholder) | platform, creator, age (`*` = from discovery),
  title, labels or **Unclassified** / **Classification failed**, significant flags, latest
  metrics, rights | virality badge with **SCORED / PROVISIONAL / INSUFFICIENT EVIDENCE**
  and confidence (a missing score shows "—") | review buttons + Open original. "Details / Why?"
  expands: CANONICAL / DISCOVERED VIA (public propagation) / MANUAL / PROVENANCE, component
  breakdown (unavailable components say so, with the reason), AI summary.
- **Public propagation vs provenance** in the UI comes from the same adapter-declared
  `sightingRole` as scoring (`splitSources`); unknown adapters render as provenance.
- **No media handling:** no proxying, downloading, or embeds; "Open original" links to the
  canonical URL.

### Review workflow (cluster-level)

- Decisions: **Approved** (worth progressing — never publishes anything), **Saved**,
  **Rejected**, **Already used**. Each click appends a `review_events` row for the **cluster**;
  the latest event is the effective status; history is shown on the detail page. Repeating the
  current decision with the same note is a no-op (idempotent). Optional note (≤ 500 chars).
- The UI updates optimistically and reverts with an error message if the server action fails.
- **Rights are separate:** unknown / requested / granted / denied / own_content, appended to the
  `rights` history per cluster (holder, evidence URL, notes). "Approved + rights unknown" is a
  valid, visible state. No outreach or rights-request automation.
- **Clusters:** every video belongs to one (backfilled in migration 0004). A cluster shows one
  card (its representative), its confirmed versions, and all sightings; one decision covers all
  versions. Near-duplicates join a cluster only when confirmed (see "Identity: exact vs
  near-duplicate").

## Identity: exact vs near-duplicate (Phase 4.5)

| Concept      | Meaning                                                                                 |
| ------------ | --------------------------------------------------------------------------------------- |
| **Video**    | One platform representation: `(platform, platform_video_id)`.                           |
| **Cluster**  | One believed underlying piece of content; holds one or more videos.                     |
| **Sighting** | Where/how a representation was observed (a source, a post, a chart). Never a new video. |

- **Exact identity is authoritative and unchanged.** `(platform, platform_video_id)` is unique;
  the same upload seen by any source is one video. Near-duplicate detection only ever relates
  videos with _different_ exact identities.
- **Near-duplicate identity** is a separate, evidence-based layer in `@vd/dedupe`
  (`near-dup-v1`), deterministic and explainable, no model involved.

### Signals and thresholds

| Signal           | Measure                                                                                                               | Grades → points                                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Thumbnail        | 64-bit DCT pHash, Hamming distance (uniform letter/pillar-box bars trimmed first; near-uniform frames are not hashed) | ≤3 identical +45 · ≤7 very close +35 · ≤14 similar +15 · 15–21 inconclusive 0 · ≥22 different −30                                                  |
| Duration         | Δ within max(abs, rel of the longer)                                                                                  | ≤max(1 s, 3 %) match +25 · ≤max(3 s, 10 %) close +12 · >max(5 s, 25 %) **different −50 (veto)**                                                    |
| Title/caption    | distinctive tokens (stopwords, URLs, @mentions, emoji and generic tags like #funny/#fyp/#shorts removed)              | Jaccard ≥0.6 (or containment ≥0.8 with ≥3 shared) strong +20 · ≥0.35 moderate +10 · ≥2 shared weak +4; conflicting numbers ("part 1"/"part 2") −20 |
| Creator          | normalized handle/display name                                                                                        | same +10; different is **neutral** (reposts are by others)                                                                                         |
| Publication      | both publish times known                                                                                              | ≤72 h +5 · ≤30 d +2                                                                                                                                |
| Shared reference | the same individual post (sighting `postUrl`) pointed at both                                                         | +5                                                                                                                                                 |

Never used: view counts, virality scores, content category — they say nothing about identity.

**Decisions:** `possible` needs no veto, ≥2 independent positive signals (thumbnail, duration,
title, creator) and ≥40 points. A thumbnail judged _different_ without a duration match is a
veto (this is what separates "same trend, different video" from a repost). **`auto_confirmed`**
additionally needs: very close/identical thumbnail **and** exact duration match **and** title
(moderate+) or creator support, no conflicting numbers, **different platforms**, ≥75 points,
no human "not the same" between the clusters, and not both clusters already carrying human
review/rights history. Everything else waits for a human. Confidence = points/100 (capped 0.99).

**False-positive policy.** A false merge silently hides a different clip and mixes review/rights
histories; a missed merge costs one extra card a human can still link. So one strong signal is
never enough, a duration mismatch vetoes, TikTok pairs (no duration from oEmbed) can never
auto-merge, same-platform pairs (re-uploads, series episodes) always get a human look, and a
missing signal never counts as evidence of difference. Since `near-dup-v1.1`, a
**same-platform pair without a thumbnail comparison** also needs title evidence (moderate+) or a
shared referencing post: one creator's clips often share a length (60 s Twitch clips), so
creator + duration alone is vetoed (`SAME_PLATFORM_WITHOUT_VISUAL_OR_TITLE_EVIDENCE`).

### Candidate generation (bounded, no all-pairs)

`duplicates scan` / `tick` / the `scan-duplicates` job select a bounded set of target videos
(unprocessed by default; `--recent`, `--platform`, `--video`, `--cluster`, `--limit`). Phase 1
fingerprints every target (thumbnail hash once per URL, distinctive tokens); phase 2 runs three
indexed, `LIMIT`ed blocking queries per target (default 40 each), and assesses only those pairs:

1. duration window ±max(3 s, 10 %) within ±120 days of publish/discovery (btree `duration_ms`);
2. thumbnail-hash band overlap (8 one-byte bands in a GIN-indexed `text[]`; pigeonhole
   guarantees any pair within distance 7 shares a band), across all time — reuploads can be late;
3. distinctive-token overlap within the time window (GIN-indexed `match_tokens`).

Cost is O(targets × 3 × K), independent of table size. Ingest resets `duplicate_scanned_at` when
title, caption, duration, publish time or thumbnail URL change.

### Thumbnail fetching (the only network path)

HTTPS only, default port, no userinfo, no IP-literal hosts; host must be a known adapter CDN
(`ytimg.com`, `ggpht.com`, `jtvnw.net`, `twitch.tv`, `tiktokcdn*.com`, `ibyteimg.com`, `bsky.app`);
DNS answers are checked **at connect time** (custom `lookup`) and refused unless every address is
globally routable (no loopback/private/link-local/CGNAT/metadata/ULA/mapped-private), which also
closes DNS rebinding; redirects followed manually (max 3), each hop re-validated; no cookies or
credential headers, fresh connection per request; 2 MB cap (declared and streamed); `image/jpeg`
or `image/png` content type plus magic-byte sniffing (only `video.cdn.bsky.app`, which serves real
JPEG thumbnails as `application/octet-stream`, may send that generic type — its bytes must then
sniff as JPEG/PNG); 6 s overall timeout; decode capped at 12 MP.
Failures become a stored status (`host_not_allowed`, `too_large`, `decode_failed`, …) and
detection continues without the thumbnail; terminal failures are remembered per URL, transient
ones (`timeout`, `http_error`, `fetch_failed`) are retried by a later scan. Source video media is
never requested.

### Human review and merging

The detail page lists **Possible duplicates** (platform, thumbnail, title, duration, confidence,
evidence lines, why it was not auto-merged, Open original) with **Confirm same video** / **Not
the same**. The feed card only shows "N possible duplicates" and the confirmed version
platforms. Possible duplicates share nothing (review, rights, classification) until confirmed.

- **Not the same** is cluster-level: other open suggestions between the same two clusters are
  rejected too, rescans never resurface them, and a confirm across a rejected pair is refused.
- **Confirm / auto-confirm merge** (one transaction): the older cluster survives; videos (with
  their sightings, snapshots, scores) move; review events, rights records, classifications and
  classification failures move and keep `origin_cluster_id`; the absorbed cluster row stays with
  `merged_into_cluster_id` (old links redirect; redirects are flattened to one hop); a
  `cluster_merges` row records each side's review/rights state, what moved, the representative
  before/after, and any conflict. Nothing is deleted. Un-merging is not supported.
- **Representative policy** (first difference wins): available › has a measured virality score
  (Phase 5: whether one exists, never its size — so a merge cannot hide a cluster's evidence) ›
  has canonical metrics › usable https thumbnail › richer metadata (title, duration, publish time,
  creator) › earliest publish time (likelier original) › earliest discovery › id. Popularity is
  never consulted. Feed metrics and score are the representative's.
- **Review conflict:** both sides had a current decision and they differ (or either side was
  already in conflict) → the cluster has _no_ effective decision ("Review conflict") until a new
  decision is recorded after the merge. Same decision or one-sided → it stands.
- **Rights conflict (stricter):** different statuses on both sides; both granted/own content
  without the same recorded rights holder; or a one-sided grant/own content (it covered one
  representation only) → "Needs review (merge conflict)", never shown or filtered as granted,
  until a new rights record is saved. One-sided unknown/requested/denied carry over.

### For a future planner

`excludeDuplicatesOfSelected({ selectedClusterIds | selectedVideoIds, candidateClusterIds?,
minPossibleConfidence = 0.6 })` returns `{ kept, excluded[] }`: excludes selected clusters,
clusters merged into them (confirmed), and open possible duplicates of them at or above the
threshold; human-rejected pairs never exclude. No planner exists.

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
six queues on boot and registers handlers for five of them (three since Phase 3,
`classify-cluster` since Phase 4, `scan-duplicates` since Phase 4.5):

| Job                | Handler                                        | Idempotency                                                               |
| ------------------ | ---------------------------------------------- | ------------------------------------------------------------------------- |
| `discover-source`  | `runSourceQuery` for the stored query          | videos upsert; sightings unique per run                                   |
| `refresh-metrics`  | `refreshMetrics` grouped by canonical platform | snapshots unique per (video, captured_at)                                 |
| `score-video`      | `scoreVideo` (current algorithm only)          | a row is stored only if the evidence fingerprint changed                  |
| `classify-cluster` | `classifyCluster` (current taxonomy + prompt)  | a row only for new (versions, input fingerprint); no-op when unconfigured |
| `scan-duplicates`  | `scanDuplicates` for the given video ids       | hashes once per URL; suggestions upserted; human decisions never touched  |

`classify-cluster` (Phase 4) classifies one cluster: idempotent (versions + input fingerprint),
throws only for retryable provider failures so pg-boss retries, and completes as a no-op with a
warning when no classifier is configured. `normalize-item` stays handler-less. The worker still creates **no
pg-boss schedules**: `pnpm cli tick` (cron-friendly) runs one pass of
`discover-due` → `refresh-metrics --due` (every platform with a `metrics.refresh`
adapter) → `rescore` (stale only).

## Data retention (design constraint, not yet implemented)

Platform terms constrain how long we may keep data (see each source doc). This is
why `videos.raw_payload` is isolated with `raw_payload_fetched_at`,
`videos.availability` exists, and review/rights hang off clusters rather than raw
payloads. A retention/deletion job is required **before** any source goes to
production use.

## Compilation planner — not planned (Phase 5 scope decision)

Earlier drafts described an optional compilation planner. **As of Phase 5 it is out of scope:**
the operator handles editing, compilation structure, captions/hooks and publishing externally,
and takes selected clips out of the system with the metadata/link export. The useful pieces
remain as general capabilities, not as a planner: cluster-level review and rights,
already-used protection, and `excludeDuplicatesOfSelected` (duplicate-aware selection) in
`@vd/dedupe`. No planner tables, jobs or code exist.

## Out of scope (by design)

Downloading/ripping third-party video · extracting media URLs (e.g. Bluesky HLS
playlists are never stored) · bypassing auth, anti-bot, DRM, paywalls · unofficial
scraping (TikTok pages, Reddit, `bsky.app` HTML) · following TikTok short-link redirects ·
publishing and social scheduling (done externally by the operator) · compilation planning,
script/hook generation, video editing · media downloading or "download available" claims
without an official asset · any specific AI-generation provider.

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

## Decisions (Phase 3.1)

1. **Sighting role is declared by the adapter** (`propagation` | `provenance`); manual
   submissions are provenance and never count as spread.
2. **Creator outlier is age-matched** (nearest snapshot within a relative window, publish times
   required, ≥ 5 matches); otherwise unavailable — never the old age-blind comparison.
3. **Time-based staleness** via `scores.next_rescore_at` derived from the freshness curve;
   stops below a floor.
4. **Algorithm version `breakout-v1.1`**; weights and fallback constants unchanged (not
   recalibrated against hand-written examples).

## Decisions (Phase 4)

1. **Content analysis is separate from virality**: classification never feeds the score, and a
   score change never triggers reclassification (only content inputs or versions do).
2. **Provider-neutral classification** behind `ContentClassifier`; Anthropic first; invalid
   output quarantined in `classification_failures`, never stored as a classification.
3. **Classification gate** (score ≥ `CLASSIFICATION_MIN_SCORE`, or saved/approved) plus explicit
   Classify/Reclassify; idempotent per (taxonomy, prompt, input fingerprint).
4. **Review and rights are append-only, cluster-level histories**; approval ≠ rights.
5. **Singleton clusters** until near-duplicate detection exists (superseded in Phase 4.5).
6. **Server-rendered internal dashboard** reading `@vd/review`; optional token gate only.

## Decisions (Phase 4.5)

1. **Exact identity stays authoritative**; near-duplicates are a separate evidence layer that
   only relates different `(platform, platform_video_id)` pairs.
2. **Deterministic, explainable detector** (per-signal evidence + points), no LLM, no
   popularity or category inputs.
3. **Conservative:** ≥2 independent signals, duration veto, strict multi-signal cross-platform
   auto-confirmation; false merges are worse than missed merges.
4. **Merges move, never delete**, and record conflicts; review/rights conflicts need a human;
   rights are never widened by a merge.
5. **Bounded blocking** (duration, hash bands, tokens; LIMIT per block) instead of all-pairs.
6. **Thumbnail hashing only via an allowlisted, SSRF-hardened fetch**; failures are statuses.
7. **Duplicate analysis never blocks discovery:** async job, and the last isolated step of `tick`.

## Decisions (Phase 5)

1. **Product = daily viral-video inbox**; editing/compilation/publishing happen outside.
2. **No new scoring formula:** Viral Now = freshness window + untriaged + existing score order.
3. **Saved, Obtained, Already used are separate**; Obtained is its own append-only history.
4. **"Already used" dominates merges** so reposts can't make used content fresh.
5. **Source link ≠ media download**; downloads only via an explicit official `media_assets` row.
6. **`tick` is the production loop** (cron), now including classification; no heavy scheduler.
