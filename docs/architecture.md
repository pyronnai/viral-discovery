# Architecture

_Status: Phase 1 (foundations). Last updated 2026-09-28._

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

| Stage                | Responsibility                                                                                                                                                                               | Phase 1 status                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Source adapters**  | Talk to one platform via an approved access method; yield `RawItem`s.                                                                                                                        | Contract + registry + test kit. No platform adapters.                   |
| **Ingestion**        | Run a `SourceQuery` through its adapter, record a `DiscoveryRun`, persist raw items and `Sighting`s, account quota in `api_usage`.                                                           | Job name + payload schema (`discover-source`). No handler.              |
| **Normalization**    | `adapter.normalize(raw)` → `NormalizedVideo`, validated by `safeNormalize()` at the boundary. Invalid items are quarantined, never silently dropped.                                         | Schema + boundary validator implemented. No handler (`normalize-item`). |
| **Enrichment**       | Resolve cross-platform links (e.g. a community post pointing at a video), fetch creator details (`creator.enrich`).                                                                          | Capability defined. Not implemented.                                    |
| **Deduplication**    | Exact: `(platform, platform_video_id)` unique. Near-duplicate: cluster by thumbnail hash + duration + title similarity into `clusters`. Review status is per cluster, so reposts inherit it. | Constraints + `clusters` table. Algorithm not implemented.              |
| **Metric snapshots** | Time series of engagement readings. Every metric is explicitly a value or unavailable-with-reason.                                                                                           | Table + domain model. No handler (`refresh-metrics`).                   |
| **Scoring**          | Velocity/engagement/outlier/freshness score, per-platform normalized, **versioned** (`scores.algorithm_version`).                                                                            | Table. No handler (`score-video`).                                      |
| **Classification**   | Multi-label categories + safety flags, **versioned** by taxonomy, model, and prompt.                                                                                                         | Table. No handler (`classify-cluster`).                                 |
| **Review**           | Human decisions (`approved`, `rejected`, `saved`, `already_used`) as an append-only event log per cluster.                                                                                   | Table. No UI.                                                           |

## Packages

| Package                | Role                                                                                                             | Depends on   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------ |
| `@vd/config`           | Zod-validated env, Pino logger factory.                                                                          | —            |
| `@vd/core`             | Storage-agnostic domain types, enums, metric model, job contracts.                                               | —            |
| `@vd/adapter-contract` | `SourceAdapter` interface, manifest/capabilities, normalized schemas, quota budget, registry, contract test kit. | core, config |
| `@vd/db`               | Drizzle schema, client, migrations, health check.                                                                | core, config |
| `@vd/worker` (app)     | pg-boss runtime: queues, handler registration, adapter wiring.                                                   | all packages |
| `@vd/cli` (app)        | Infrastructure commands: `health`, `config-check`, `db-check`.                                                   | config, db   |

Rule: **core never imports an adapter, and nothing but `apps/worker/src/adapters.ts`
wires adapters in.** Adding or removing a source is a change in one place.

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
`refresh-metrics`, `score-video`, `classify-cluster` — and registers **no handlers**
in Phase 1. Payloads are validated with the Zod schemas in `@vd/core` before any
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

Downloading/ripping third-party video · bypassing auth, anti-bot, DRM, paywalls ·
unofficial scraping · publishing (later phase, separate service) · any specific
AI-generation provider.

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
