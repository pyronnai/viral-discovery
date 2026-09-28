/**
 * Drizzle schema — Phase 1 foundation.
 * Conventions:
 *  - uuid primary keys (gen_random_uuid()), timestamptz everywhere.
 *  - JSONB only for adapter-specific settings, discovery context, versioned
 *    model outputs, and isolated raw external payloads.
 *  - Indexes: uniqueness constraints plus FK lookups the pipeline will obviously need.
 *    Anything else waits for real query patterns.
 *  - Publishing tables intentionally absent until publishing exists.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  CONTENT_ORIGINS,
  DISCOVERY_RUN_STATUSES,
  DISCOVERY_RUN_TRIGGERS,
  REVIEW_STATUSES,
  RIGHTS_STATUSES,
  SCORE_STATES,
  SOURCE_QUERY_KINDS,
  VIDEO_AVAILABILITIES,
  type ClassificationLabel,
  type MetricKey,
  type MetricUnavailableReason,
} from '@vd/core';

// ── enums (values come from @vd/core so DB and domain can't drift) ─────────
export const contentOriginEnum = pgEnum('content_origin', CONTENT_ORIGINS);
export const rightsStatusEnum = pgEnum('rights_status', RIGHTS_STATUSES);
export const reviewStatusEnum = pgEnum('review_status', REVIEW_STATUSES);
export const discoveryRunStatusEnum = pgEnum('discovery_run_status', DISCOVERY_RUN_STATUSES);
export const discoveryRunTriggerEnum = pgEnum('discovery_run_trigger', DISCOVERY_RUN_TRIGGERS);
export const sourceQueryKindEnum = pgEnum('source_query_kind', SOURCE_QUERY_KINDS);
export const videoAvailabilityEnum = pgEnum('video_availability', VIDEO_AVAILABILITIES);
export const scoreStateEnum = pgEnum('score_state', SCORE_STATES);

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => tz('created_at').notNull().defaultNow();
const updatedAt = () =>
  tz('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ── sources & queries ─────────────────────────────────────────────────────
export const sources = pgTable('sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  adapterId: text('adapter_id').notNull(),
  name: text('name').notNull().unique(),
  enabled: boolean('enabled').notNull().default(false),
  /** Adapter-specific NON-secret settings. */
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  /** Per-bucket daily quota budgets, e.g. {"search.list": 100, "default": 10000}. */
  dailyQuotaBudgets: jsonb('daily_quota_budgets')
    .$type<Record<string, number>>()
    .notNull()
    .default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sourceQueries = pgTable(
  'source_queries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    kind: sourceQueryKindEnum('kind').notNull(),
    params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
    region: text('region'),
    cadenceMinutes: integer('cadence_minutes'),
    enabled: boolean('enabled').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('source_queries_source_id_idx').on(t.sourceId),
    check(
      'source_queries_cadence_positive',
      sql`${t.cadenceMinutes} IS NULL OR ${t.cadenceMinutes} > 0`,
    ),
  ],
);

export const discoveryRuns = pgTable(
  'discovery_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    sourceQueryId: uuid('source_query_id').references(() => sourceQueries.id, {
      onDelete: 'set null',
    }),
    trigger: discoveryRunTriggerEnum('trigger').notNull(),
    status: discoveryRunStatusEnum('status').notNull().default('queued'),
    startedAt: tz('started_at'),
    finishedAt: tz('finished_at'),
    itemsFound: integer('items_found').notNull().default(0),
    itemsNew: integer('items_new').notNull().default(0),
    error: text('error'),
    /** What was asked: adapter, query kind, params, region, limit, filters. */
    request: jsonb('request').$type<Record<string, unknown>>().notNull().default({}),
    /**
     * Per-run evidence for debugging: counts of ingested/filtered/invalid items plus
     * capped samples of filtered and quarantined items (nothing is dropped silently).
     */
    stats: jsonb('stats').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index('discovery_runs_source_id_idx').on(t.sourceId),
    // "When did this query last run?" for cadence scheduling.
    index('discovery_runs_query_created_idx').on(t.sourceQueryId, t.createdAt),
  ],
);

// ── creators, clusters, videos ─────────────────────────────────────────────
export const creators = pgTable(
  'creators',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    platform: text('platform').notNull(),
    platformCreatorId: text('platform_creator_id').notNull(),
    handle: text('handle'),
    displayName: text('display_name'),
    profileUrl: text('profile_url'),
    followerCount: bigint('follower_count', { mode: 'number' }),
    baselineMedianViews: bigint('baseline_median_views', { mode: 'number' }),
    firstSeenAt: tz('first_seen_at').notNull().defaultNow(),
    lastRefreshedAt: tz('last_refreshed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('creators_platform_creator_uq').on(t.platform, t.platformCreatorId)],
);

export const clusters = pgTable('clusters', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Circular with videos.cluster_id; nullable and SET NULL so either side can be deleted.
  representativeVideoId: uuid('representative_video_id').references((): AnyPgColumn => videos.id, {
    onDelete: 'set null',
  }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const videos = pgTable(
  'videos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    platform: text('platform').notNull(),
    platformVideoId: text('platform_video_id').notNull(),
    canonicalUrl: text('canonical_url').notNull(),
    creatorId: uuid('creator_id').references(() => creators.id, { onDelete: 'set null' }),
    /** Attribution as observed on the item — retained even when no creator row resolves. */
    creatorHandle: text('creator_handle'),
    creatorDisplayName: text('creator_display_name'),
    title: text('title'),
    caption: text('caption'),
    publishedAt: tz('published_at'),
    durationMs: integer('duration_ms'),
    thumbnailUrl: text('thumbnail_url'),
    thumbnailPhash: text('thumbnail_phash'),
    language: text('language'),
    contentOrigin: contentOriginEnum('content_origin').notNull().default('discovered_external'),
    availability: videoAvailabilityEnum('availability').notNull().default('available'),
    clusterId: uuid('cluster_id').references((): AnyPgColumn => clusters.id, {
      onDelete: 'set null',
    }),
    /** Isolated raw external payload. Subject to platform retention/deletion rules. */
    rawPayload: jsonb('raw_payload'),
    rawPayloadFetchedAt: tz('raw_payload_fetched_at'),
    firstDiscoveredAt: tz('first_discovered_at').notNull().defaultNow(),
    lastRefreshedAt: tz('last_refreshed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('videos_platform_video_uq').on(t.platform, t.platformVideoId),
    index('videos_cluster_id_idx').on(t.clusterId),
    check('videos_duration_nonneg', sql`${t.durationMs} IS NULL OR ${t.durationMs} >= 0`),
  ],
);

export const sightings = pgTable(
  'sightings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    videoId: uuid('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    discoveryRunId: uuid('discovery_run_id').references(() => discoveryRuns.id, {
      onDelete: 'set null',
    }),
    context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
    /**
     * Distinguishes observations of one video within one run (e.g. the Bluesky post
     * that linked it, or the regional chart it appeared in).
     */
    observationKey: text('observation_key').notNull().default(''),
    seenAt: tz('seen_at').notNull().defaultNow(),
  },
  (t) => [
    index('sightings_video_id_idx').on(t.videoId),
    // Re-running the same run (e.g. a retried job) cannot duplicate sightings;
    // a new run records a new sighting — presence over time is evidence.
    unique('sightings_run_video_observation_uq').on(t.discoveryRunId, t.videoId, t.observationKey),
  ],
);

// ── metrics & scoring ──────────────────────────────────────────────────────
export const metricSnapshots = pgTable(
  'metric_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    videoId: uuid('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id').references(() => sources.id, { onDelete: 'set null' }),
    capturedAt: tz('captured_at').notNull(),
    // NULL = not observed. The reason lives in `unavailable`.
    views: bigint('views', { mode: 'number' }),
    likes: bigint('likes', { mode: 'number' }),
    comments: bigint('comments', { mode: 'number' }),
    shares: bigint('shares', { mode: 'number' }),
    upvotes: bigint('upvotes', { mode: 'number' }),
    upvoteRatio: real('upvote_ratio'),
    /** Why each NULL metric is missing, e.g. {"shares": "not_provided_by_platform"}. */
    unavailable: jsonb('unavailable')
      .$type<Partial<Record<MetricKey, MetricUnavailableReason>>>()
      .notNull()
      .default({}),
    createdAt: createdAt(),
  },
  (t) => [
    unique('metric_snapshots_video_captured_uq').on(t.videoId, t.capturedAt),
    check(
      'metric_snapshots_ratio_range',
      sql`${t.upvoteRatio} IS NULL OR (${t.upvoteRatio} >= 0 AND ${t.upvoteRatio} <= 1)`,
    ),
  ],
);

export const scores = pgTable(
  'scores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    videoId: uuid('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    algorithmVersion: text('algorithm_version').notNull(),
    /** 0–100. NULL when state = insufficient_evidence — a score is never invented. */
    value: doublePrecision('value'),
    state: scoreStateEnum('state').notNull().default('scored'),
    /** 0–1: how much evidence supports the value (snapshots, normalization, publish time). */
    confidence: real('confidence').notNull().default(0),
    /** Per-component availability, values, and explanation inputs. */
    components: jsonb('components').$type<Record<string, unknown>>().notNull().default({}),
    missingMetrics: jsonb('missing_metrics').$type<MetricKey[]>().notNull().default([]),
    /** Machine-readable explanation, e.g. ["VELOCITY_VERY_STRONG", "SINGLE_SNAPSHOT"]. */
    reasonCodes: jsonb('reason_codes').$type<string[]>().notNull().default([]),
    /** Hash of the evidence used; identical evidence is not re-stored (idempotent rescoring). */
    inputsHash: text('inputs_hash'),
    basedOnSnapshotId: uuid('based_on_snapshot_id').references(() => metricSnapshots.id, {
      onDelete: 'set null',
    }),
    computedAt: tz('computed_at').notNull().defaultNow(),
    /**
     * When time alone (freshness decay) makes this score stale. NULL = only new
     * evidence triggers rescoring (insufficient evidence, or aged out).
     */
    nextRescoreAt: tz('next_rescore_at'),
  },
  (t) => [
    index('scores_video_id_idx').on(t.videoId),
    index('scores_video_version_computed_idx').on(t.videoId, t.algorithmVersion, t.computedAt),
    check(
      'scores_value_matches_state',
      sql`(${t.state} = 'insufficient_evidence') = (${t.value} IS NULL)`,
    ),
    check('scores_confidence_range', sql`${t.confidence} >= 0 AND ${t.confidence} <= 1`),
  ],
);

// ── classification & review ───────────────────────────────────────────────
export const classifications = pgTable(
  'classifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clusterId: uuid('cluster_id')
      .notNull()
      .references(() => clusters.id, { onDelete: 'cascade' }),
    taxonomyVersion: text('taxonomy_version').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    labels: jsonb('labels').$type<ClassificationLabel[]>().notNull().default([]),
    safetyFlags: jsonb('safety_flags').$type<string[]>().notNull().default([]),
    rationale: text('rationale'),
    createdAt: createdAt(),
  },
  (t) => [index('classifications_cluster_id_idx').on(t.clusterId)],
);

export const reviewEvents = pgTable(
  'review_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clusterId: uuid('cluster_id')
      .notNull()
      .references(() => clusters.id, { onDelete: 'cascade' }),
    status: reviewStatusEnum('status').notNull(),
    note: text('note'),
    reviewer: text('reviewer').notNull().default('owner'),
    createdAt: createdAt(),
  },
  (t) => [index('review_events_cluster_id_idx').on(t.clusterId)],
);

// ── rights ─────────────────────────────────────────────────────────────────
export const rights = pgTable(
  'rights',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clusterId: uuid('cluster_id')
      .notNull()
      .references(() => clusters.id, { onDelete: 'cascade' }),
    /** Optional: the specific upload a grant refers to (grants from reposters are not grants). */
    videoId: uuid('video_id').references(() => videos.id, { onDelete: 'set null' }),
    status: rightsStatusEnum('status').notNull().default('unknown'),
    rightsHolder: text('rights_holder'),
    contact: text('contact'),
    licenseTerms: text('license_terms'),
    evidenceUrl: text('evidence_url'),
    requestedAt: tz('requested_at'),
    decidedAt: tz('decided_at'),
    expiresAt: tz('expires_at'),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('rights_cluster_id_idx').on(t.clusterId)],
);

// ── api usage / cost accounting ────────────────────────────────────────────
export const apiUsage = pgTable(
  'api_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    usageDate: date('usage_date', { mode: 'string' }).notNull(),
    quotaBucket: text('quota_bucket').notNull().default('default'),
    unitsUsed: integer('units_used').notNull().default(0),
    requestCount: integer('request_count').notNull().default(0),
    costEstimateUsd: numeric('cost_estimate_usd', { precision: 12, scale: 4 }),
    updatedAt: updatedAt(),
  },
  (t) => [unique('api_usage_source_date_bucket_uq').on(t.sourceId, t.usageDate, t.quotaBucket)],
);

export const ALL_TABLES = {
  sources,
  sourceQueries,
  discoveryRuns,
  creators,
  clusters,
  videos,
  sightings,
  metricSnapshots,
  scores,
  classifications,
  reviewEvents,
  rights,
  apiUsage,
} as const;
