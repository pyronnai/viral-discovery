/**
 * Core domain entities. These mirror the database tables but are storage-agnostic:
 * the core pipeline reasons about these types, not about Drizzle rows or adapter payloads.
 */
import type {
  ContentOrigin,
  DiscoveryRunStatus,
  DiscoveryRunTrigger,
  PlatformId,
  ReviewStatus,
  RightsStatus,
  SourceQueryKind,
  VideoAvailability,
} from './enums.ts';
import type { MetricKey, MetricReadings } from './metrics.ts';

export type Uuid = string;

/** A configured instance of a source adapter (e.g. "youtube-main"). */
export interface Source {
  id: Uuid;
  /** Matches an AdapterManifest.id registered in the adapter registry. */
  adapterId: string;
  name: string;
  enabled: boolean;
  /** Adapter-specific, NON-secret settings. Secrets live in env vars. */
  config: Record<string, unknown>;
  /** Daily quota budgets per quota bucket (e.g. {"search.list": 100}). Configurable, never hardcoded. */
  dailyQuotaBudgets: Record<string, number>;
  createdAt: Date;
  updatedAt: Date;
}

export interface SourceQuery {
  id: Uuid;
  sourceId: Uuid;
  kind: SourceQueryKind;
  params: Record<string, unknown>;
  region: string | null;
  /** How often to run when scheduling exists. null = manual only. */
  cadenceMinutes: number | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface DiscoveryRun {
  id: Uuid;
  sourceId: Uuid;
  sourceQueryId: Uuid | null;
  trigger: DiscoveryRunTrigger;
  status: DiscoveryRunStatus;
  startedAt: Date | null;
  finishedAt: Date | null;
  itemsFound: number;
  itemsNew: number;
  error: string | null;
  createdAt: Date;
}

export interface Creator {
  id: Uuid;
  platform: PlatformId;
  platformCreatorId: string;
  handle: string | null;
  displayName: string | null;
  profileUrl: string | null;
  followerCount: number | null;
  /** Median views across the creator's recent uploads; feeds the "outlier" score component. */
  baselineMedianViews: number | null;
  firstSeenAt: Date;
  lastRefreshedAt: Date | null;
}

export interface Video {
  id: Uuid;
  platform: PlatformId;
  platformVideoId: string;
  canonicalUrl: string;
  creatorId: Uuid | null;
  /** Attribution as observed on the item itself — kept even if no Creator row can be resolved. */
  creatorHandle: string | null;
  creatorDisplayName: string | null;
  title: string | null;
  caption: string | null;
  publishedAt: Date | null;
  durationMs: number | null;
  thumbnailUrl: string | null;
  thumbnailPhash: string | null;
  language: string | null;
  contentOrigin: ContentOrigin;
  availability: VideoAvailability;
  clusterId: Uuid | null;
  firstDiscoveredAt: Date;
  lastRefreshedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** One observation of a video by one source/run. A video can have many sightings. */
export interface Sighting {
  id: Uuid;
  videoId: Uuid;
  sourceId: Uuid;
  discoveryRunId: Uuid | null;
  /** Where it was seen, e.g. {"subreddit": "funny", "rank": 3}. */
  context: Record<string, unknown>;
  seenAt: Date;
}

export interface MetricSnapshot {
  id: Uuid;
  videoId: Uuid;
  sourceId: Uuid | null;
  capturedAt: Date;
  readings: MetricReadings;
}

/** A group of videos believed to be the same underlying content (original + reposts). */
export interface Cluster {
  id: Uuid;
  representativeVideoId: Uuid | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Score {
  id: Uuid;
  videoId: Uuid;
  /** Scoring algorithm version, so scores from different formulas are never compared blindly. */
  algorithmVersion: string;
  value: number;
  components: Record<string, number>;
  /** Which metrics were missing when this score was computed. */
  missingMetrics: MetricKey[];
  computedAt: Date;
}

export interface ClassificationLabel {
  label: string;
  confidence: number;
}

export interface Classification {
  id: Uuid;
  clusterId: Uuid;
  taxonomyVersion: string;
  model: string;
  promptVersion: string;
  labels: ClassificationLabel[];
  safetyFlags: string[];
  rationale: string | null;
  createdAt: Date;
}

/** Append-only. The current review status of a cluster is its latest event. */
export interface ReviewEvent {
  id: Uuid;
  clusterId: Uuid;
  status: ReviewStatus;
  note: string | null;
  reviewer: string;
  createdAt: Date;
}

/**
 * Permission to reuse/republish. Attached to a cluster (the content), optionally
 * pinned to the specific upload the grant refers to. History is kept: the latest
 * record per cluster is the current state.
 */
export interface RightsRecord {
  id: Uuid;
  clusterId: Uuid;
  videoId: Uuid | null;
  status: RightsStatus;
  rightsHolder: string | null;
  contact: string | null;
  licenseTerms: string | null;
  evidenceUrl: string | null;
  requestedAt: Date | null;
  decidedAt: Date | null;
  expiresAt: Date | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}
