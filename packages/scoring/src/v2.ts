/**
 * Breakout score v2 — "is this ALREADY performing exceptionally for its age?"
 *
 * Useful from the FIRST authoritative snapshot; later snapshots refine it.
 *
 *   P  inferred pace   views (or likes) per hour since publish, at the latest
 *                      snapshot: count ÷ max(age, minAgeHours); log-scaled and
 *                      normalized per platform (documented fallback scale,
 *                      blended with a platform percentile once a population exists)
 *   M  measured velocity  growth per hour between our own snapshots — the SAME
 *                      units and normalization as P
 *   β  observed share  span / (span + observationHalfSpanHours), span = time
 *                      covered by our snapshots (0 with one snapshot)
 *   F  age discount    1 for ageGraceHours, then halves every ageHalfLifeHours;
 *                      applies to the inferred part only (a lifetime average says
 *                      little about "now"; a measured rate does)
 *   R  reach           log-scaled current count on a per-platform scale: how much
 *                      audience stands behind the number
 *
 *   paceCore = (1 − β) · P · F + β · M
 *   core     = paceCore^paceExponent · R^reachExponent      (reach stays in the core)
 *   score    = 100 · softCap(core · trend · engagement · creator + propagationBonus)
 *
 * softCap is the identity up to `softCapKnee` and then approaches 1 smoothly, so the
 * bounded modifiers can lift a strong candidate without many ties at 100.
 *
 * Bounded modifiers: trend ±trend.maxAdjustment (scaled by β), engagement and
 * creator outlier (reused v1.1 measurements) ×[1 − a, 1 + a] / ×[1, 1 + a], and an
 * additive propagation bonus. Confidence is reported, never multiplied in:
 * "provisional" means less certain, not less viral.
 *
 * States: insufficient_evidence (no score) — no canonical metric, reach below
 * minReach (watching a post nobody engages with is still no evidence), or no
 * usable age and no measurement;
 * provisional — inferred pace only; scored — measured velocity exists.
 */
import { METRIC_KEYS, type ScoreState } from '@vd/core';
import { BREAKOUT_V1_1_CONFIG, type BreakoutV1Config } from './config.ts';
import {
  available,
  clamp01,
  earlierPoint,
  percentile,
  round,
  scoreCandidateV1,
  series,
  unavailable,
  valueOf,
  type Point,
} from './score.ts';
import type {
  Component,
  GrowthMetric,
  ScoreResult,
  ScoringInput,
  V2ComponentName,
  ViralNowAssessment,
} from './types.ts';

const HOUR = 3_600_000;

/** [lo, hi] in log10(1 + x): lo maps to 0, hi maps to 1. */
export type LogScale = readonly [number, number];

export interface PlatformScales {
  /** Inferred pace / measured velocity per hour. */
  pace: Record<GrowthMetric, LogScale>;
  /** Current total count. */
  reach: Record<GrowthMetric, LogScale>;
}

export interface ScoringConfig {
  version: string;
  /** Minimum time between two snapshots for a measured velocity. */
  minSpanMinutes: number;
  /** Pace denominator floor, so a minutes-old video cannot produce an absurd rate. */
  minAgeHours: number;
  /** Fallback scales per platform ("default" for platforms without their own). */
  scales: Record<string, PlatformScales>;
  paceExponent: number;
  reachExponent: number;
  /** Below this reach there is not enough quantitative evidence (measured or not). */
  minReach: number;
  ageGraceHours: number;
  ageHalfLifeHours: number;
  /** β = span / (span + this): ≈0.5 after +2h, ≈0.8 after +8h, ≈0.92 after +24h. */
  observationHalfSpanHours: number;
  /** Platform percentile blending: starts at minPopulation, reaches maxShare at fullPopulation. */
  percentile: { minPopulation: number; fullPopulation: number; maxShare: number };
  /** Trend: rate ratio clamped to [1/maxRatio, maxRatio]; ratioForMax ⇒ ±maxAdjustment. */
  trend: { maxAdjustment: number; ratioForMax: number; maxRatio: number };
  /** Engagement ×[1 − a, 1 + a]; creator outlier ×[1, 1 + a]. */
  engagementAdjustment: number;
  creatorAdjustment: number;
  /** Additive bonus (0–1 scale) at full cross-source / source-propagation strength. */
  propagationBonus: { crossSource: number; sourcePropagation: number };
  viralNow: {
    /** Default Viral Now window in hours (the inbox may override it). */
    windowHours: number;
    minScore: number;
    /**
     * Measured revival: normalized measured velocity, observed share, and a rate
     * at least `revivalMinTrendRatio` × the earlier rate (renewed, not decaying).
     */
    revivalMinVelocity: number;
    revivalMinObservedShare: number;
    revivalMinTrendRatio: number;
  };
  /** Above this, scores approach 1 smoothly instead of clipping (keeps the top ordered). */
  softCapKnee: number;
  /** Time-only rescoring as the age discount decays. */
  ageRescoreDelta: number;
  ageRescoreFloor: number;
  /** v1.1 configuration used for the reused engagement/propagation/creator measurements. */
  measurements: BreakoutV1Config;
}

/**
 * Fallback scales. YouTube: pace 10/h → 0 … 50k/h → 1, reach 100 → 0 … 1M → 1.
 * Twitch clips: pace 5/h … 5k/h, reach 100 … 100k (a deliberately high audience bar:
 * a few hundred clip views is a small sample, while a clip with tens of thousands
 * competes with the best YouTube videos). Platforms without view counts (Bluesky)
 * are measured in likes: 1 like/h … 1k likes/h, reach 10 … 10k likes.
 */
const VIEWS_DEFAULT: PlatformScales = {
  pace: { views: [1, 4.7], likes: [0, 3] },
  reach: { views: [2, 6], likes: [1, 4] },
};

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  version: 'breakout-v2',
  minSpanMinutes: 30,
  minAgeHours: 1,
  scales: {
    default: VIEWS_DEFAULT,
    youtube: VIEWS_DEFAULT,
    twitch: {
      pace: { views: [0.78, 3.7], likes: [0, 3] },
      reach: { views: [2, 5], likes: [1, 4] },
    },
  },
  paceExponent: 0.6,
  reachExponent: 0.4,
  minReach: 0.1,
  ageGraceHours: 24,
  ageHalfLifeHours: 48,
  observationHalfSpanHours: 2,
  percentile: { minPopulation: 30, fullPopulation: 100, maxShare: 0.5 },
  trend: { maxAdjustment: 0.15, ratioForMax: 4, maxRatio: 8 },
  engagementAdjustment: 0.1,
  creatorAdjustment: 0.1,
  propagationBonus: { crossSource: 0.05, sourcePropagation: 0.05 },
  viralNow: {
    windowHours: 48,
    minScore: 30,
    revivalMinVelocity: 0.6,
    revivalMinObservedShare: 0.5,
    revivalMinTrendRatio: 1,
  },
  softCapKnee: 0.8,
  ageRescoreDelta: 0.05,
  ageRescoreFloor: 0.05,
  measurements: BREAKOUT_V1_1_CONFIG,
};

/** Fallback scale, blended with the platform percentile once a population exists. */
function normalizeRate(
  logValue: number,
  scale: LogScale,
  sample: readonly number[],
  config: ScoringConfig,
) {
  const fallback = clamp01((logValue - scale[0]) / (scale[1] - scale[0]));
  const { minPopulation, fullPopulation, maxShare } = config.percentile;
  const share =
    sample.length >= minPopulation
      ? maxShare * clamp01((sample.length - minPopulation) / (fullPopulation - minPopulation))
      : 0;
  const pct = share > 0 ? percentile(sample, logValue) : null;
  return {
    value: (1 - share) * fallback + share * (pct ?? 0),
    fallback,
    percentile: pct,
    percentileShare: round(share, 3),
    populationSize: sample.length,
    normalization: share > 0 ? ('mixed' as const) : ('absolute_fallback' as const),
  };
}

/** Identity up to the knee, then 1 − (1 − knee)·e^(−(x − knee)/(1 − knee)): monotone, < 1. */
export function softCap(x: number, knee: number): number {
  if (x <= knee) return Math.max(0, x);
  const room = 1 - knee;
  return knee + room * (1 - Math.exp(-(x - knee) / room));
}

function ageDiscount(ageHours: number, config: ScoringConfig): number {
  return ageHours <= config.ageGraceHours
    ? 1
    : 0.5 ** ((ageHours - config.ageGraceHours) / config.ageHalfLifeHours);
}

export function scoreCandidate(
  input: ScoringInput,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): ScoreResult {
  const asOf = input.asOf.getTime();
  const reasons: string[] = [];
  const minSpanMs = config.minSpanMinutes * 60_000;
  // Engagement, propagation and creator outlier are v1.1's audited measurements;
  // v2 changes how evidence is combined, not how those are measured.
  const v1 = scoreCandidateV1(input, config.measurements);
  const snapshots = input.snapshots.filter((s) => s.capturedAt.getTime() <= asOf);

  const viewPoints = series(snapshots, 'views');
  const likePoints = series(snapshots, 'likes');
  const metric: GrowthMetric | null =
    viewPoints.length > 0 ? 'views' : likePoints.length > 0 ? 'likes' : null;
  const points: Point[] = metric === 'views' ? viewPoints : likePoints;
  if (metric === null) reasons.push('NO_CANONICAL_METRICS');
  else if (metric === 'likes') reasons.push('NO_VIEW_METRIC');
  const scales = config.scales[input.platform] ?? config.scales['default'] ?? VIEWS_DEFAULT;
  const paceSample = metric ? (input.population.logPace?.[metric] ?? []) : [];

  const published =
    input.publishedAt && input.publishedAt.getTime() <= asOf ? input.publishedAt.getTime() : null;
  if (published === null) reasons.push('PUBLISH_TIME_UNKNOWN');
  const ageNowHours = Math.max(0, asOf - (published ?? input.firstDiscoveredAt.getTime())) / HOUR;
  const last = points[points.length - 1] ?? null;

  // ── reach ─────────────────────────────────────────────────────────────────
  let reach: Component;
  let R = 0;
  if (!metric || !last) {
    reach = unavailable(
      'no canonical growth metric (views or likes)',
      config.reachExponent,
      'canonical',
    );
  } else {
    const logCount = Math.log10(1 + Math.max(0, last.value));
    const scale = scales.reach[metric];
    R = clamp01((logCount - scale[0]) / (scale[1] - scale[0]));
    reach = available(
      R,
      config.reachExponent,
      'canonical',
      { metric, count: last.value, logCount: round(logCount), scale: [...scale] },
      'absolute_fallback',
    );
    if (R < config.minReach) reasons.push('REACH_BELOW_MINIMUM');
  }

  // ── inferred pace (first-snapshot evidence) ──────────────────────────────
  let pace: Component;
  let P: number | null = null;
  if (!metric || !last) {
    pace = unavailable(
      'no canonical growth metric (views or likes)',
      config.paceExponent,
      'canonical',
    );
  } else if (published === null) {
    pace = unavailable(
      'publish time unknown: time since discovery would overstate pace',
      config.paceExponent,
      'canonical',
    );
  } else {
    const ageHours = Math.max(0, (last.at - published) / HOUR);
    const perHour = Math.max(0, last.value) / Math.max(ageHours, config.minAgeHours);
    const logPace = Math.log10(1 + perHour);
    const n = normalizeRate(logPace, scales.pace[metric], paceSample, config);
    P = n.value;
    pace = available(
      P,
      config.paceExponent,
      'canonical',
      {
        metric,
        count: last.value,
        ageHours: round(ageHours, 2),
        minAgeHours: config.minAgeHours,
        perHour: round(perHour, 2),
        logPace: round(logPace),
        fallbackNorm: round(n.fallback),
        percentileNorm: n.percentile === null ? null : round(n.percentile),
        percentileShare: n.percentileShare,
        populationSize: n.populationSize,
      },
      n.normalization,
    );
    if (ageHours < config.minAgeHours) reasons.push('AGE_BELOW_PACE_FLOOR');
  }

  // ── age discount (inferred part only) ─────────────────────────────────────
  const F = ageDiscount(ageNowHours, config);
  const age = available(F, 0, 'canonical', {
    ageHours: round(ageNowHours, 2),
    ageFrom: published === null ? 'first_discovered_at (lower bound on true age)' : 'published_at',
    graceHours: config.ageGraceHours,
    halfLifeHours: config.ageHalfLifeHours,
  });

  // ── measured velocity (our own snapshots) ─────────────────────────────────
  let velocity: Component;
  let M: number | null = null;
  let measuredPerHour = 0;
  let beta = 0;
  const prev = last ? earlierPoint(points, last, minSpanMs) : null;
  const first = points[0] ?? null;
  if (!metric || !last) {
    velocity = unavailable('no canonical growth metric', 0, 'canonical');
  } else if (points.length < 2) {
    velocity = unavailable('needs 2 snapshots; have 1', 0, 'canonical');
    reasons.push('SINGLE_SNAPSHOT');
  } else if (!prev || !first) {
    velocity = unavailable(
      `snapshots less than ${config.minSpanMinutes} min apart`,
      0,
      'canonical',
    );
    reasons.push('SNAPSHOTS_TOO_CLOSE');
  } else {
    const hours = (last.at - prev.at) / HOUR;
    const gained = Math.max(0, last.value - prev.value);
    if (last.value < prev.value) reasons.push('METRIC_DECREASED');
    measuredPerHour = gained / hours;
    const logPerHour = Math.log10(1 + measuredPerHour);
    const n = normalizeRate(logPerHour, scales.pace[metric], paceSample, config);
    M = n.value;
    const spanHours = (last.at - first.at) / HOUR;
    beta = spanHours / (spanHours + config.observationHalfSpanHours);
    velocity = available(
      M,
      0,
      'canonical',
      {
        metric,
        from: { at: new Date(prev.at).toISOString(), value: prev.value },
        to: { at: new Date(last.at).toISOString(), value: last.value },
        hours: round(hours, 3),
        perHour: round(measuredPerHour, 2),
        logPerHour: round(logPerHour),
        observedSpanHours: round(spanHours, 2),
        observedShare: round(beta, 3),
        fallbackNorm: round(n.fallback),
        percentileShare: n.percentileShare,
        populationSize: n.populationSize,
      },
      n.normalization,
    );
  }

  // ── trend (bounded, weighted by how much we measured) ────────────────────
  let trend: Component;
  let trendFactor = 1;
  let trendRatio: number | null = null;
  let earlierRate: number | null = null;
  let earlierBasis = '';
  const earliest = prev ? earlierPoint(points, prev, minSpanMs) : null;
  if (prev && earliest) {
    earlierRate = Math.max(0, prev.value - earliest.value) / ((prev.at - earliest.at) / HOUR);
    earlierBasis = 'previous measured interval';
  } else if (prev && published !== null) {
    earlierRate =
      Math.max(0, prev.value) / Math.max((prev.at - published) / HOUR, config.minAgeHours);
    earlierBasis = 'lifetime pace at the earlier snapshot';
  }
  if (M === null || earlierRate === null) {
    trend = unavailable(
      M === null
        ? 'needs a measured velocity'
        : 'no earlier rate to compare with (publish time unknown)',
      config.trend.maxAdjustment,
      'canonical',
    );
  } else {
    const { maxRatio, ratioForMax, maxAdjustment } = config.trend;
    const ratio =
      earlierRate <= 0
        ? measuredPerHour <= 0
          ? 1
          : maxRatio
        : Math.min(maxRatio, Math.max(1 / maxRatio, measuredPerHour / earlierRate));
    trendRatio = ratio;
    const direction = Math.max(-1, Math.min(1, Math.log2(ratio) / Math.log2(ratioForMax)));
    const adjustment = maxAdjustment * direction * beta;
    trendFactor = 1 + adjustment;
    trend = available(0.5 + direction / 2, maxAdjustment, 'canonical', {
      earlierPerHour: round(earlierRate, 2),
      earlierBasis,
      laterPerHour: round(measuredPerHour, 2),
      ratio: round(ratio, 3),
      adjustment: round(adjustment, 4),
    });
    if (ratio > 1.25) reasons.push('ACCELERATING');
    else if (ratio < 0.8) reasons.push('DECELERATING');
  }

  // ── reused measurements → bounded modifiers / bonus ─────────────────────
  const rebrand = (c: Component, weight: number): Component => ({ ...c, weight });
  const engagement = rebrand(v1.components.engagement, config.engagementAdjustment);
  const creatorOutlier = rebrand(v1.components.creatorOutlier, config.creatorAdjustment);
  const crossSource = rebrand(v1.components.crossSource, config.propagationBonus.crossSource);
  const sourcePropagation = rebrand(
    v1.components.sourcePropagation,
    config.propagationBonus.sourcePropagation,
  );
  const engagementFactor = engagement.available
    ? 1 + config.engagementAdjustment * (2 * engagement.value - 1)
    : 1;
  const creatorFactor = creatorOutlier.available
    ? 1 + config.creatorAdjustment * creatorOutlier.value
    : 1;
  const bonus =
    (crossSource.available ? config.propagationBonus.crossSource * crossSource.value : 0) +
    (sourcePropagation.available
      ? config.propagationBonus.sourcePropagation * sourcePropagation.value
      : 0);
  // Reasons that explain the reused measurements carry over verbatim.
  const carried = [
    'CREATOR_OUTLIER',
    'CREATOR_BASELINE_UNAVAILABLE',
    'NON_PROPAGATION_OBSERVATIONS',
    'ENGAGEMENT_STRONG',
    'ENGAGEMENT_VERY_STRONG',
  ];
  for (const r of v1.reasonCodes)
    if (r.startsWith('CROSS_SOURCE_') || carried.includes(r)) reasons.push(r);

  // ── state, momentum, score ────────────────────────────────────────────────
  let state: ScoreState;
  let momentum: Component;
  let score: number | null = null;
  let rawScore: number | null = null;
  if (!metric) {
    state = 'insufficient_evidence';
  } else if (M === null && P === null) {
    state = 'insufficient_evidence';
    reasons.push('NO_PACE_EVIDENCE');
  } else if (R < config.minReach) {
    state = 'insufficient_evidence';
  } else {
    state = M === null ? 'provisional' : 'scored';
  }
  if (state === 'insufficient_evidence') {
    momentum = unavailable(
      !metric
        ? 'no canonical growth metric'
        : P === null && M === null
          ? 'no usable pace: publish time unknown and no measured velocity yet'
          : `reach below minimum (${config.minReach}): too little audience to judge`,
      1,
      'canonical',
    );
  } else {
    const inferredPart = P === null ? null : P * F;
    const paceCore =
      M === null
        ? (inferredPart ?? 0)
        : inferredPart === null
          ? M
          : (1 - beta) * inferredPart + beta * M;
    const core = paceCore ** config.paceExponent * R ** config.reachExponent;
    rawScore = round(
      softCap(core * trendFactor * engagementFactor * creatorFactor + bonus, config.softCapKnee),
    );
    score = Math.round(1000 * rawScore) / 10;
    momentum = available(core, 1, 'canonical', {
      paceCore: round(paceCore),
      inferredPart: inferredPart === null ? null : round(inferredPart),
      measuredPart: M === null ? null : round(M),
      observedShare: round(beta, 3),
      reach: round(R),
      paceExponent: config.paceExponent,
      reachExponent: config.reachExponent,
      factors: {
        trend: round(trendFactor),
        engagement: round(engagementFactor),
        creator: round(creatorFactor),
        propagationBonus: round(bonus),
      },
    });
    const { strength: s } = momentum as { strength: string };
    if (s === 'very strong') reasons.push('MOMENTUM_VERY_STRONG');
    else if (s === 'strong') reasons.push('MOMENTUM_STRONG');
  }

  // ── confidence (reported, not multiplied in) ─────────────────────────────
  let confidence = 0;
  if (state !== 'insufficient_evidence') {
    confidence = 0.2 + 0.3 * R + 0.35 * beta;
    if (published !== null) confidence += 0.05;
    const share = (pace.available ? (pace.details['percentileShare'] as number) : 0) || 0;
    if (share > 0) confidence += 0.1 * (share / config.percentile.maxShare);
    confidence = round(Math.min(1, confidence), 2);
  }

  // ── Viral Now evidence (time window / review / safety applied by the inbox) ─
  const viralNow: ViralNowAssessment = {
    evidence:
      state !== 'insufficient_evidence' &&
      R >= config.minReach &&
      score !== null &&
      score >= config.viralNow.minScore,
    revival:
      M !== null &&
      M >= config.viralNow.revivalMinVelocity &&
      beta >= config.viralNow.revivalMinObservedShare &&
      trendRatio !== null &&
      trendRatio >= config.viralNow.revivalMinTrendRatio &&
      R >= config.minReach,
    windowHours: config.viralNow.windowHours,
  };
  if (viralNow.evidence) reasons.push('VIRAL_NOW_EVIDENCE');
  if (viralNow.revival) reasons.push('MEASURED_REVIVAL');

  // ── time-based staleness: the age discount decays the inferred part ────────
  let nextRescoreAt: Date | null = null;
  if (state !== 'insufficient_evidence' && P !== null && beta < 0.999 && published !== null) {
    const floor = config.ageRescoreFloor;
    if (F > floor + 1e-9) {
      const target = Math.max(F - config.ageRescoreDelta, floor);
      const ageAtTarget = config.ageGraceHours + config.ageHalfLifeHours * Math.log2(1 / target);
      nextRescoreAt = new Date(published + Math.ceil(ageAtTarget * HOUR));
    }
  }

  const components: Record<V2ComponentName, Component> = {
    momentum,
    pace,
    reach,
    age,
    velocity,
    trend,
    engagement,
    creatorOutlier,
    crossSource,
    sourcePropagation,
  };
  const latestSnapshot = [...snapshots].sort(
    (a, b) => b.capturedAt.getTime() - a.capturedAt.getTime(),
  )[0];
  return {
    algorithmVersion: config.version,
    state,
    score,
    rawScore,
    confidence,
    components,
    viralNow,
    reasonCodes: [...new Set(reasons)].sort(),
    missingMetrics: METRIC_KEYS.filter(
      (k) => !latestSnapshot || valueOf(latestSnapshot, k) === null,
    ),
    growthMetric: metric,
    observations: v1.observations,
    nextRescoreAt,
  };
}
