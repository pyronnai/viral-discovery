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
  ACQUISITION_STATUSES,
  CONTENT_ORIGINS,
  DISCOVERY_RUN_STATUSES,
  DUPLICATE_STATUSES,
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
export const duplicateStatusEnum = pgEnum('duplicate_status', DUPLICATE_STATUSES);
export const acquisitionStatusEnum = pgEnum('acquisition_status', ACQUISITION_STATUSES);

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

/**
 * A cluster is one believed underlying piece of content. Videos (platform
 * representations) join a cluster by exact identity at ingest, or by a confirmed
 * near-duplicate merge. A merged-away cluster is kept (never deleted) and points
 * at the cluster that absorbed it.
 */
export const clusters = pgTable('clusters', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Circular with videos.cluster_id; nullable and SET NULL so either side can be deleted.
  representativeVideoId: uuid('representative_video_id').references((): AnyPgColumn => videos.id, {
    onDelete: 'set null',
  }),
  /** Set when this cluster was merged into another; it then has no videos of its own. */
  mergedIntoClusterId: uuid('merged_into_cluster_id').references((): AnyPgColumn => clusters.id, {
    onDelete: 'set null',
  }),
  mergedAt: tz('merged_at'),
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
    /** 64-bit DCT perceptual hash of the thumbnail (16 hex chars); NULL if not computed. */
    thumbnailPhash: text('thumbnail_phash'),
    /** Outcome of the last hashing attempt: hashed | no_thumbnail | host_not_allowed | fetch_failed | … */
    thumbnailHashStatus: text('thumbnail_hash_status'),
    /** The thumbnail URL the hash/status refers to (a new URL triggers one new attempt). */
    thumbnailHashUrl: text('thumbnail_hash_url'),
    thumbnailHashedAt: tz('thumbnail_hashed_at'),
    /** 8 one-byte bands of the hash ("0:a3", …) for indexed near-hash candidate search. */
    thumbnailHashBands: text('thumbnail_hash_bands').array(),
    /** Distinctive normalized title/caption tokens for indexed candidate search. */
    matchTokens: text('match_tokens').array(),
    /** When near-duplicate analysis last ran for this video; NULL = unprocessed. */
    duplicateScannedAt: tz('duplicate_scanned_at'),
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
    // Near-duplicate candidate generation (blocking) — never an all-pairs scan.
    index('videos_duration_idx').on(t.durationMs),
    index('videos_hash_bands_idx').using('gin', t.thumbnailHashBands),
    index('videos_match_tokens_idx').using('gin', t.matchTokens),
    index('videos_duplicate_scanned_idx').on(t.duplicateScannedAt),
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
export interface ClassificationSafetyFlag {
  flag: string;
  confidence: number;
  note: string;
}

/**
 * Content classifications of a cluster (history is kept; the latest row for the
 * current taxonomy + prompt version is the effective one). Labels, flags, and
 * analysis are model-generated hypotheses, separate from deterministic scores.
 */
export const classifications = pgTable(
  'classifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clusterId: uuid('cluster_id')
      .notNull()
      .references(() => clusters.id, { onDelete: 'cascade' }),
    /** The representative video whose inputs were classified. */
    videoId: uuid('video_id').references(() => videos.id, { onDelete: 'set null' }),
    taxonomyVersion: text('taxonomy_version').notNull(),
    provider: text('provider').notNull().default('unknown'),
    /** The model that actually produced the output. */
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    labels: jsonb('labels').$type<ClassificationLabel[]>().notNull().default([]),
    safetyFlags: jsonb('safety_flags').$type<ClassificationSafetyFlag[]>().notNull().default([]),
    /** One-sentence neutral summary of what the video appears to show. */
    rationale: text('rationale'),
    /** "Why this may work" hypotheses (hook, payoff, …). Never facts. */
    analysis: jsonb('analysis').$type<Record<string, string | null>>().notNull().default({}),
    /** Which inputs were available/used (title, caption, thumbnail used|unavailable|none, …). */
    inputsUsed: jsonb('inputs_used').$type<Record<string, unknown>>().notNull().default({}),
    /** Fingerprint of the content inputs; a change makes the cluster eligible again. */
    inputHash: text('input_hash').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [
    index('classifications_cluster_id_idx').on(t.clusterId),
    index('classifications_cluster_version_idx').on(
      t.clusterId,
      t.taxonomyVersion,
      t.promptVersion,
      t.createdAt,
    ),
  ],
);

/**
 * Failed classification attempts (invalid output, refusal, provider errors).
 * Invalid model output is never written to `classifications`; it is quarantined here
 * as an error summary (no raw model response).
 */
export const classificationFailures = pgTable(
  'classification_failures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clusterId: uuid('cluster_id')
      .notNull()
      .references(() => clusters.id, { onDelete: 'cascade' }),
    videoId: uuid('video_id').references(() => videos.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    taxonomyVersion: text('taxonomy_version').notNull(),
    promptVersion: text('prompt_version').notNull(),
    inputHash: text('input_hash').notNull(),
    errorKind: text('error_kind').notNull(),
    error: text('error').notNull(),
    details: jsonb('details').$type<string[]>().notNull().default([]),
    retryable: boolean('retryable').notNull().default(false),
    attemptedAt: tz('attempted_at').notNull().defaultNow(),
  },
  (t) => [index('classification_failures_cluster_idx').on(t.clusterId, t.attemptedAt)],
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
    /** Set when a cluster merge carried this event over from the absorbed cluster. */
    originClusterId: uuid('origin_cluster_id').references((): AnyPgColumn => clusters.id, {
      onDelete: 'set null',
    }),
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
    /** Set when a cluster merge carried this record over from the absorbed cluster. */
    originClusterId: uuid('origin_cluster_id').references((): AnyPgColumn => clusters.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('rights_cluster_id_idx').on(t.clusterId)],
);

// ── acquisition & media availability ───────────────────────────────────────
/**
 * Append-only record of whether the operator obtained the source media externally
 * (latest per cluster is current). Tracking only: nothing here downloads media.
 */
export const acquisitionEvents = pgTable(
  'acquisition_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clusterId: uuid('cluster_id')
      .notNull()
      .references(() => clusters.id, { onDelete: 'cascade' }),
    status: acquisitionStatusEnum('status').notNull(),
    /** Optional: which representation it was obtained from. */
    videoId: uuid('video_id').references(() => videos.id, { onDelete: 'set null' }),
    note: text('note'),
    /** Set when a cluster merge carried this record over from the absorbed cluster. */
    originClusterId: uuid('origin_cluster_id').references((): AnyPgColumn => clusters.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (t) => [index('acquisition_events_cluster_idx').on(t.clusterId, t.createdAt)],
);

/**
 * A lawful, downloadable media asset explicitly provided by an OFFICIAL/authorized
 * API or rights holder. Empty unless such a source exists: source links ("Open
 * original") never imply a download, and no player/CDN URL is ever extracted.
 */
export const mediaAssets = pgTable(
  'media_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    videoId: uuid('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    /** e.g. 'official_download'. */
    kind: text('kind').notNull(),
    url: text('url').notNull(),
    /** Who provided it (adapter id or rights holder). */
    provider: text('provider').notNull(),
    licenseNote: text('license_note'),
    expiresAt: tz('expires_at'),
    createdAt: createdAt(),
  },
  (t) => [unique('media_assets_video_url_uq').on(t.videoId, t.url)],
);

// ── near-duplicates ────────────────────────────────────────────────────────
/**
 * A detected (or human-decided) near-duplicate relationship between two videos
 * with different exact identities. One row per unordered pair (video_a_id <
 * video_b_id). Evidence is the explainable per-signal breakdown, never a bare flag.
 */
export const duplicateCandidates = pgTable(
  'duplicate_candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    videoAId: uuid('video_a_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    videoBId: uuid('video_b_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    status: duplicateStatusEnum('status').notNull().default('possible'),
    /** 0–1 detector confidence at the last evaluation. */
    confidence: real('confidence').notNull(),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default({}),
    /** Machine-readable explanation, e.g. ["THUMBNAIL_VERY_CLOSE", "AUTO_BLOCKED_NO_DURATION"]. */
    reasons: jsonb('reasons').$type<string[]>().notNull().default([]),
    detectorVersion: text('detector_version').notNull(),
    firstDetectedAt: tz('first_detected_at').notNull().defaultNow(),
    lastEvaluatedAt: tz('last_evaluated_at').notNull().defaultNow(),
    decidedAt: tz('decided_at'),
    /** 'owner' for human decisions, 'detector' for auto-confirmation. */
    decidedBy: text('decided_by'),
    note: text('note'),
  },
  (t) => [
    unique('duplicate_candidates_pair_uq').on(t.videoAId, t.videoBId),
    index('duplicate_candidates_video_b_idx').on(t.videoBId),
    index('duplicate_candidates_status_idx').on(t.status),
    check('duplicate_candidates_ordered_pair', sql`${t.videoAId} < ${t.videoBId}`),
    check(
      'duplicate_candidates_confidence_range',
      sql`${t.confidence} >= 0 AND ${t.confidence} <= 1`,
    ),
  ],
);

/**
 * Audit trail of cluster consolidation. Nothing is deleted by a merge: videos and
 * cluster-level histories move to the survivor; this row records what each side's
 * review/rights state was and whether a human must resolve a conflict.
 */
export const clusterMerges = pgTable(
  'cluster_merges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    survivorClusterId: uuid('survivor_cluster_id')
      .notNull()
      .references(() => clusters.id, { onDelete: 'cascade' }),
    absorbedClusterId: uuid('absorbed_cluster_id')
      .notNull()
      .references(() => clusters.id, { onDelete: 'cascade' }),
    duplicateCandidateId: uuid('duplicate_candidate_id').references(() => duplicateCandidates.id, {
      onDelete: 'set null',
    }),
    /** 'human' (confirmed) or 'auto' (auto_confirmed). */
    trigger: text('trigger').notNull(),
    representativeVideoId: uuid('representative_video_id').references(() => videos.id, {
      onDelete: 'set null',
    }),
    /** Both sides had different current review decisions — a human must choose. */
    reviewConflict: boolean('review_conflict').notNull().default(false),
    /** Rights records cannot safely be combined — a human must record the merged rights. */
    rightsConflict: boolean('rights_conflict').notNull().default(false),
    /** Each side's review/rights state at merge time and the moved record counts. */
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    mergedAt: tz('merged_at').notNull().defaultNow(),
  },
  (t) => [
    index('cluster_merges_survivor_idx').on(t.survivorClusterId, t.mergedAt),
    index('cluster_merges_absorbed_idx').on(t.absorbedClusterId),
  ],
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
  classificationFailures,
  reviewEvents,
  rights,
  duplicateCandidates,
  clusterMerges,
  acquisitionEvents,
  mediaAssets,
  apiUsage,
} as const;
