import type { MetricKey, ScoreState } from '@vd/core';

/** One canonical metric snapshot. null = the metric was unavailable in that reading. */
export interface SnapshotInput {
  capturedAt: Date;
  metrics: Partial<Record<MetricKey, number | null>>;
}

/** Engagement of the *discovery-source item* (e.g. a Bluesky post), never the video. */
export interface SourceEngagement {
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  quotes: number | null;
}

export interface SightingInput {
  sourceId: string;
  /** Platform of the adapter behind the source; null if unknown. */
  sourcePlatform: string | null;
  observationKey: string;
  runId: string | null;
  seenAt: Date;
  /** From sighting context `postEngagement`, when the source item has its own engagement. */
  sourceEngagement: SourceEngagement | null;
}

/** Latest growth-metric values of the creator's OTHER videos (for the outlier factor). */
export interface CreatorHistory {
  otherVideoValues: number[];
}

/**
 * Rolling distributions from previously scored videos of the same platform, used
 * for percentile normalization. Empty/small samples → absolute fallback.
 */
export interface PlatformPopulation {
  /** log10(1 + growth per hour) values, per growth metric. */
  logVelocity: Partial<Record<GrowthMetric, number[]>>;
  /** Engagement ratios (metric / views). */
  engagementRate: Partial<Record<EngagementMetric, number[]>>;
}

export type GrowthMetric = 'views' | 'likes';
export type EngagementMetric = 'likes' | 'comments' | 'shares';

export interface ScoringInput {
  platform: string;
  publishedAt: Date | null;
  firstDiscoveredAt: Date;
  snapshots: SnapshotInput[];
  sightings: SightingInput[];
  creator: CreatorHistory | null;
  population: PlatformPopulation;
  /** The instant the score is computed for. Never read from a clock inside the scorer. */
  asOf: Date;
}

export const COMPONENT_NAMES = [
  'velocity',
  'acceleration',
  'engagement',
  'freshness',
  'crossSource',
  'sourcePropagation',
  'creatorOutlier',
] as const;
export type ComponentName = (typeof COMPONENT_NAMES)[number];

/** Where a component's evidence comes from. Never merged. */
export type EvidenceBasis = 'canonical' | 'discovery' | 'source_propagation';

export type Strength = 'very strong' | 'strong' | 'moderate' | 'weak' | 'very weak';

export type Component =
  | {
      available: true;
      /** 0–1 */
      value: number;
      strength: Strength;
      weight: number;
      basis: EvidenceBasis;
      normalization?: 'platform_percentile' | 'absolute_fallback' | 'mixed';
      details: Record<string, unknown>;
    }
  | {
      available: false;
      reason: string;
      weight: number;
      basis: EvidenceBasis;
      details?: Record<string, unknown>;
    };

export interface ScoreResult {
  algorithmVersion: string;
  state: ScoreState;
  /** 0–100 with one decimal, or null for insufficient_evidence. */
  score: number | null;
  /** Weighted mean of available components before evidence dampening (0–1). */
  rawScore: number | null;
  confidence: number;
  components: Record<ComponentName, Component>;
  reasonCodes: string[];
  missingMetrics: MetricKey[];
  growthMetric: GrowthMetric | null;
}
