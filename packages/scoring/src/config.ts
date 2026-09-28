import type { ComponentName, EngagementMetric, GrowthMetric } from './types.ts';

/**
 * Every tunable of the breakout score. Changing any value is a new algorithm:
 * bump `version` so scores from different formulas are never compared blindly.
 */
export interface ScoringConfig {
  version: string;
  weights: Record<ComponentName, number>;
  /** Minimum time between two snapshots for a velocity reading. */
  minSpanMinutes: number;
  /** Velocity blend: absolute (log growth/hour) vs relative (growth / previous count). */
  velocityAbsoluteShare: number;
  /** log10(1 + growth/hour) that maps to 1.0 when no platform population exists. */
  velocityReferenceLog: Record<GrowthMetric, number>;
  /** Relative growth per hour that maps to 1.0 (0.5 = +50%/h). */
  relativeGrowthReference: number;
  /** Engagement ratio (metric / views) that maps to 1.0 without a population. */
  engagementReference: Record<EngagementMetric, number>;
  /** Views needed before ratios mean anything. */
  minViewsForEngagement: number;
  /** Freshness halves every this many hours of age. */
  freshnessHalfLifeHours: number;
  /** Source-item interactions (likes+reposts+replies+quotes) that map to 1.0. */
  propagationReference: number;
  /** Creator outlier: views ÷ creator median that maps to 1.0. */
  creatorOutlierReferenceRatio: number;
  minCreatorVideos: number;
  /** Population size needed before percentile normalization replaces the fallback. */
  minPopulation: number;
  /** Acceleration ratio clamp (later velocity ÷ earlier velocity). */
  maxAccelerationRatio: number;
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  version: 'breakout-v1',
  weights: {
    velocity: 0.3,
    acceleration: 0.1,
    engagement: 0.15,
    freshness: 0.15,
    crossSource: 0.1,
    sourcePropagation: 0.1,
    creatorOutlier: 0.1,
  },
  minSpanMinutes: 30,
  velocityAbsoluteShare: 0.6,
  // 10^5 ≈ 100k views/hour; 10^3.5 ≈ 3.2k likes/hour.
  velocityReferenceLog: { views: 5, likes: 3.5 },
  relativeGrowthReference: 0.5,
  engagementReference: { likes: 0.05, comments: 0.005, shares: 0.005 },
  minViewsForEngagement: 100,
  freshnessHalfLifeHours: 36,
  propagationReference: 1_000,
  creatorOutlierReferenceRatio: 20,
  minCreatorVideos: 5,
  minPopulation: 30,
  maxAccelerationRatio: 8,
};
