/**
 * Breakout score v1 — deterministic, explainable, and honest about missing data.
 *
 * score = 100 × weightedMean(available components) × (0.5 + 0.5 × confidence)
 *
 * Only AVAILABLE components are averaged (their weights renormalized), so a
 * platform that does not expose a metric is not punished for it. Low evidence
 * (e.g. one snapshot) dampens the score and is reported in `state`/`confidence`.
 * Canonical metrics and discovery-source propagation are separate components.
 */
import { METRIC_KEYS, type MetricKey, type ScoreState } from '@vd/core';
import { BREAKOUT_V1_1_CONFIG, type BreakoutV1Config } from './config.ts';
import {
  V1_COMPONENT_NAMES,
  type Component,
  type V1ComponentName,
  type EngagementMetric,
  type GrowthMetric,
  type ScoreResult,
  type ScoringInput,
  type SnapshotInput,
  type Strength,
} from './types.ts';

const HOUR = 3_600_000;
const ENGAGEMENT_METRICS: readonly EngagementMetric[] = ['likes', 'comments', 'shares'];

export interface Point {
  at: number;
  value: number;
}

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const round = (x: number, digits = 4) => Math.round(x * 10 ** digits) / 10 ** digits;

export function strength(value: number): Strength {
  if (value >= 0.85) return 'very strong';
  if (value >= 0.65) return 'strong';
  if (value >= 0.45) return 'moderate';
  if (value >= 0.25) return 'weak';
  return 'very weak';
}

/** Mid-rank percentile of x within sample (ties count half). */
export function percentile(sample: readonly number[], x: number): number {
  let below = 0;
  let equal = 0;
  for (const v of sample) {
    if (v < x) below += 1;
    else if (v === x) equal += 1;
  }
  return sample.length === 0 ? 0 : (below + equal / 2) / sample.length;
}

export function valueOf(snapshot: SnapshotInput, metric: MetricKey): number | null {
  const v = snapshot.metrics[metric];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Chronological points for one metric; the last reading wins for identical timestamps. */
export function series(snapshots: readonly SnapshotInput[], metric: MetricKey): Point[] {
  const byTime = new Map<number, number>();
  for (const s of [...snapshots].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime())) {
    const v = valueOf(s, metric);
    if (v !== null) byTime.set(s.capturedAt.getTime(), v);
  }
  return [...byTime.entries()].map(([at, value]) => ({ at, value }));
}

/** Latest point at least minSpan before `later`. */
export function earlierPoint(
  points: readonly Point[],
  later: Point,
  minSpanMs: number,
): Point | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    if (p && p.at <= later.at - minSpanMs) return p;
  }
  return null;
}

export function available(
  value: number,
  weight: number,
  basis: Component['basis'],
  details: Record<string, unknown>,
  normalization?: 'platform_percentile' | 'absolute_fallback' | 'mixed',
): Component {
  const v = round(clamp01(value));
  return {
    available: true,
    value: v,
    strength: strength(v),
    weight,
    basis,
    ...(normalization ? { normalization } : {}),
    details,
  };
}

export function unavailable(
  reason: string,
  weight: number,
  basis: Component['basis'],
  details?: Record<string, unknown>,
): Component {
  return { available: false, reason, weight, basis, ...(details ? { details } : {}) };
}

/** breakout-v1.x (historical; v2 reuses its engagement/propagation/creator measurements). */
export function scoreCandidateV1(
  input: ScoringInput,
  config: BreakoutV1Config = BREAKOUT_V1_1_CONFIG,
): ScoreResult<V1ComponentName> {
  const w = config.weights;
  const minSpanMs = config.minSpanMinutes * 60_000;
  const asOf = input.asOf.getTime();
  const reasons: string[] = [];
  // Only evidence up to asOf counts, so recalculating a past score is reproducible.
  const snapshots = input.snapshots.filter((s) => s.capturedAt.getTime() <= asOf);
  const sightings = input.sightings.filter((s) => s.seenAt.getTime() <= asOf);

  // ── growth metric: views when the platform reports them, else likes ────────
  const viewPoints = series(snapshots, 'views');
  const likePoints = series(snapshots, 'likes');
  const growthMetric: GrowthMetric | null =
    viewPoints.length > 0 ? 'views' : likePoints.length > 0 ? 'likes' : null;
  const points = growthMetric === 'views' ? viewPoints : likePoints;
  if (growthMetric === null) reasons.push('NO_CANONICAL_METRICS');
  else if (growthMetric === 'likes') reasons.push('NO_VIEW_METRIC');

  const latestSnapshot = [...snapshots].sort(
    (a, b) => b.capturedAt.getTime() - a.capturedAt.getTime(),
  )[0];
  const missingMetrics = METRIC_KEYS.filter(
    (k) => !latestSnapshot || valueOf(latestSnapshot, k) === null,
  );

  // ── velocity ────────────────────────────────────────────────────────────────
  let velocity: Component;
  let velocityNormalization: 'platform_percentile' | 'absolute_fallback' | null = null;
  const last = points[points.length - 1];
  const prev = last ? earlierPoint(points, last, minSpanMs) : null;
  if (!growthMetric || !last) {
    velocity = unavailable('no canonical growth metric (views or likes)', w.velocity, 'canonical');
  } else if (points.length < 2) {
    velocity = unavailable('needs 2 snapshots; have 1', w.velocity, 'canonical');
    reasons.push('SINGLE_SNAPSHOT');
  } else if (!prev) {
    velocity = unavailable(
      `snapshots less than ${config.minSpanMinutes} min apart`,
      w.velocity,
      'canonical',
    );
    reasons.push('SNAPSHOTS_TOO_CLOSE');
  } else {
    const hours = (last.at - prev.at) / HOUR;
    const gained = Math.max(0, last.value - prev.value);
    if (last.value < prev.value) reasons.push('METRIC_DECREASED');
    const perHour = gained / hours;
    const logPerHour = Math.log10(1 + perHour);
    const sample = input.population.logVelocity[growthMetric] ?? [];
    velocityNormalization =
      sample.length >= config.minPopulation ? 'platform_percentile' : 'absolute_fallback';
    const absolute =
      velocityNormalization === 'platform_percentile'
        ? percentile(sample, logPerHour)
        : clamp01(logPerHour / config.velocityReferenceLog[growthMetric]);
    const relativePerHour = gained / Math.max(prev.value, 1) / hours;
    const relative = clamp01(
      Math.log10(1 + 100 * relativePerHour) / Math.log10(1 + 100 * config.relativeGrowthReference),
    );
    const value =
      config.velocityAbsoluteShare * absolute + (1 - config.velocityAbsoluteShare) * relative;
    velocity = available(
      value,
      w.velocity,
      'canonical',
      {
        metric: growthMetric,
        from: { at: new Date(prev.at).toISOString(), value: prev.value },
        to: { at: new Date(last.at).toISOString(), value: last.value },
        hours: round(hours, 3),
        perHour: round(perHour, 2),
        logPerHour: round(logPerHour),
        relativeGrowthPerHour: round(relativePerHour, 6),
        absoluteNorm: round(absolute),
        relativeNorm: round(relative),
        populationSize: sample.length,
      },
      velocityNormalization,
    );
    if (velocityNormalization === 'absolute_fallback')
      reasons.push('VELOCITY_NORMALIZATION_FALLBACK');
  }

  // ── acceleration (needs 3 spaced snapshots) ─────────────────────────────────
  let acceleration: Component;
  const earliest = prev ? earlierPoint(points, prev, minSpanMs) : null;
  if (!last || !prev || !earliest) {
    acceleration = unavailable('needs 3 snapshots spaced ≥ min span', w.acceleration, 'canonical', {
      snapshots: points.length,
    });
  } else {
    const v2 = Math.max(0, last.value - prev.value) / ((last.at - prev.at) / HOUR);
    const v1 = Math.max(0, prev.value - earliest.value) / ((prev.at - earliest.at) / HOUR);
    const max = config.maxAccelerationRatio;
    const ratio = v1 <= 0 ? (v2 <= 0 ? 1 : max) : Math.min(max, Math.max(1 / max, v2 / v1));
    // ratio 4× → 1.0, flat → 0.5, 0.25× → 0.
    const value = 0.5 + Math.log2(ratio) / 4;
    acceleration = available(value, w.acceleration, 'canonical', {
      earlierPerHour: round(v1, 2),
      laterPerHour: round(v2, 2),
      ratio: round(ratio, 3),
    });
    if (ratio > 1.25) reasons.push('ACCELERATING');
    else if (ratio < 0.8) reasons.push('DECELERATING');
  }

  // ── engagement (only metrics the platform actually supplied) ────────────────
  let engagement: Component;
  const views = latestSnapshot ? valueOf(latestSnapshot, 'views') : null;
  if (!latestSnapshot || views === null) {
    engagement = unavailable('no view count to relate engagement to', w.engagement, 'canonical');
  } else if (views < config.minViewsForEngagement) {
    engagement = unavailable(
      `fewer than ${config.minViewsForEngagement} views`,
      w.engagement,
      'canonical',
    );
  } else {
    const parts: Record<string, unknown> = {};
    const norms: number[] = [];
    const methods = new Set<string>();
    for (const metric of ENGAGEMENT_METRICS) {
      const count = valueOf(latestSnapshot, metric);
      if (count === null) continue; // not supplied by this platform/reading → not penalized
      const rate = count / views;
      const sample = input.population.engagementRate[metric] ?? [];
      const method =
        sample.length >= config.minPopulation ? 'platform_percentile' : 'absolute_fallback';
      const norm =
        method === 'platform_percentile'
          ? percentile(sample, rate)
          : clamp01(rate / config.engagementReference[metric]);
      methods.add(method);
      norms.push(norm);
      parts[metric] = {
        rate: round(rate, 6),
        norm: round(norm),
        method,
        populationSize: sample.length,
      };
    }
    engagement =
      norms.length === 0
        ? unavailable('no likes/comments/shares supplied', w.engagement, 'canonical')
        : available(
            norms.reduce((a, b) => a + b, 0) / norms.length,
            w.engagement,
            'canonical',
            { views, rates: parts },
            methods.size > 1
              ? 'mixed'
              : (methods.values().next().value as 'platform_percentile' | 'absolute_fallback'),
          );
  }

  // ── freshness ───────────────────────────────────────────────────────────────
  const published =
    input.publishedAt && input.publishedAt.getTime() <= asOf ? input.publishedAt : null;
  const ageFrom = published ?? input.firstDiscoveredAt;
  if (!published) reasons.push('AGE_FROM_DISCOVERY_TIME');
  const ageHours = Math.max(0, (asOf - ageFrom.getTime()) / HOUR);
  const freshness = available(
    0.5 ** (ageHours / config.freshnessHalfLifeHours),
    w.freshness,
    'canonical',
    {
      ageHours: round(ageHours, 2),
      ageFrom: published ? 'published_at' : 'first_discovered_at (lower bound on true age)',
    },
  );

  // ── cross-source evidence (independent PUBLIC observations only) ────────────
  // Provenance sightings (e.g. a human pasting a URL) are kept for review but are
  // not evidence of spread: they never raise this component, confidence, or reasons.
  let crossSource: Component;
  const publicSightings = sightings.filter((s) => s.role === 'propagation');
  const countBySource = (list: typeof sightings) => {
    const bySource = new Map<string, Set<string>>();
    for (const s of list) {
      const keys = bySource.get(s.sourceLabel) ?? new Set<string>();
      keys.add(`${s.sourceId}\u0000${s.observationKey}`);
      bySource.set(s.sourceLabel, keys);
    }
    return [...bySource.entries()]
      .map(([source, keys]) => ({ source, observations: keys.size }))
      .sort((a, b) => a.source.localeCompare(b.source));
  };
  const observations = {
    publicPropagation: countBySource(publicSightings),
    nonPropagation: countBySource(sightings.filter((s) => s.role !== 'propagation')),
  };
  const sources = new Set(publicSightings.map((s) => s.sourceId));
  const independent = new Set(publicSightings.map((s) => `${s.sourceId}\u0000${s.observationKey}`));
  if (sightings.length === 0) {
    crossSource = unavailable('no sightings', w.crossSource, 'discovery');
  } else {
    const sourcesScore = clamp01((sources.size - 1) / 2);
    const observationsScore = independent.size > 0 ? clamp01(Math.log2(independent.size) / 4) : 0;
    crossSource = available(
      0.6 * sourcesScore + 0.4 * observationsScore,
      w.crossSource,
      'discovery',
      {
        distinctSources: sources.size,
        independentObservations: independent.size,
        publicSources: observations.publicPropagation.map((o) => o.source),
        nonPropagationObservations: observations.nonPropagation,
        totalSightings: sightings.length,
      },
    );
    if (sources.size >= 2) reasons.push(`CROSS_SOURCE_${sources.size}`);
  }
  if (observations.nonPropagation.length > 0) reasons.push('NON_PROPAGATION_OBSERVATIONS');

  // ── discovery-source propagation (e.g. Bluesky post engagement) ─────────────
  // Only from sightings on OTHER platforms: for a native video the post IS the
  // video and its engagement is already canonical.
  let sourcePropagation: Component;
  const latestByObservation = new Map<string, (typeof sightings)[number]>();
  for (const s of publicSightings) {
    if (!s.sourceEngagement || s.sourcePlatform === null || s.sourcePlatform === input.platform)
      continue;
    const key = `${s.sourceId}\u0000${s.observationKey}`;
    const existing = latestByObservation.get(key);
    if (!existing || existing.seenAt.getTime() <= s.seenAt.getTime())
      latestByObservation.set(key, s);
  }
  if (latestByObservation.size === 0) {
    sourcePropagation = unavailable(
      'no discovery-source engagement',
      w.sourcePropagation,
      'source_propagation',
    );
  } else {
    const totals = { likes: 0, reposts: 0, replies: 0, quotes: 0 };
    for (const s of latestByObservation.values()) {
      const e = s.sourceEngagement;
      if (!e) continue;
      totals.likes += e.likes ?? 0;
      totals.reposts += e.reposts ?? 0;
      totals.replies += e.replies ?? 0;
      totals.quotes += e.quotes ?? 0;
    }
    const interactions = totals.likes + totals.reposts + totals.replies + totals.quotes;
    sourcePropagation = available(
      Math.log10(1 + interactions) / Math.log10(1 + config.propagationReference),
      w.sourcePropagation,
      'source_propagation',
      {
        items: latestByObservation.size,
        interactions,
        ...totals,
        note: 'discovery-source engagement, not video metrics',
      },
    );
  }

  // ── creator outlier (age-matched) ───────────────────────────────────────────
  // "How is this video doing at about this age vs the creator's other videos at
  // about the same age?" Needs a real publish time on both sides; nearest snapshot
  // within an age window; no interpolation; unavailable otherwise.
  let creatorOutlier: Component;
  const unavailableCreator = (reason: string, details?: Record<string, unknown>) => {
    reasons.push('CREATOR_BASELINE_UNAVAILABLE');
    return unavailable(reason, w.creatorOutlier, 'canonical', details);
  };
  if (!input.creator) {
    creatorOutlier = unavailableCreator('no creator identity');
  } else if (!last) {
    creatorOutlier = unavailableCreator('no canonical growth metric');
  } else if (!input.publishedAt || input.publishedAt.getTime() > last.at) {
    creatorOutlier = unavailableCreator('candidate publish time unknown; cannot age-match');
  } else {
    const targetHours = (last.at - input.publishedAt.getTime()) / HOUR;
    const windowHours = Math.max(
      config.creatorAgeWindowMinHours,
      config.creatorAgeWindowRatio * targetHours,
    );
    const history = input.creator.videos;
    const withPublish = history.filter((v) => v.publishedAt !== null);
    const matched: { ageHours: number; value: number }[] = [];
    for (const video of withPublish) {
      const published = video.publishedAt?.getTime() ?? 0;
      let best: { ageHours: number; value: number; distance: number } | null = null;
      for (const snap of video.snapshots) {
        if (snap.capturedAt.getTime() > asOf || !Number.isFinite(snap.value) || snap.value < 0)
          continue;
        const ageHours = (snap.capturedAt.getTime() - published) / HOUR;
        const distance = Math.abs(ageHours - targetHours);
        if (ageHours < 0 || distance > windowHours) continue;
        if (!best || distance < best.distance) best = { ageHours, value: snap.value, distance };
      }
      if (best) matched.push({ ageHours: round(best.ageHours, 2), value: best.value });
    }
    const details = {
      metric: growthMetric,
      targetAgeHours: round(targetHours, 2),
      windowHours: round(windowHours, 2),
      creatorVideos: history.length,
      withPublishTime: withPublish.length,
      ageMatched: matched.length,
    };
    if (matched.length < config.minCreatorVideos) {
      creatorOutlier = unavailableCreator(
        `insufficient age-matched creator history: ${matched.length} of ${history.length} other videos have a reading within ±${round(windowHours, 1)}h of age ${round(targetHours, 1)}h (need ${config.minCreatorVideos})`,
        details,
      );
    } else {
      const sorted = matched.map((m) => m.value).sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median =
        sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
      if (median <= 0) {
        creatorOutlier = unavailableCreator('age-matched creator baseline is zero', details);
      } else {
        const ratio = last.value / median;
        creatorOutlier = available(
          Math.log10(Math.max(ratio, 1)) / Math.log10(config.creatorOutlierReferenceRatio),
          w.creatorOutlier,
          'canonical',
          {
            ...details,
            current: last.value,
            baselineMedian: median,
            ratio: round(ratio, 3),
            matched,
          },
        );
        if (ratio >= 3) reasons.push('CREATOR_OUTLIER');
      }
    }
  }

  const components: Record<V1ComponentName, Component> = {
    velocity,
    acceleration,
    engagement,
    freshness,
    crossSource,
    sourcePropagation,
    creatorOutlier,
  };

  // ── evidence state & confidence ─────────────────────────────────────────────
  let state: ScoreState;
  let confidence: number;
  if (!growthMetric) {
    state = 'insufficient_evidence';
    confidence = 0;
  } else {
    state = velocity.available ? 'scored' : 'provisional';
    confidence = velocity.available ? (acceleration.available ? 0.75 : 0.6) : 0.3;
    if (velocityNormalization === 'platform_percentile') confidence += 0.1;
    if (published) confidence += 0.05;
    if (engagement.available) confidence += 0.05;
    if (sources.size >= 2) confidence += 0.05;
    confidence = round(Math.min(1, confidence), 2);
  }

  // ── time-based staleness ────────────────────────────────────────────────────
  // Freshness decays with age even without new evidence. The score is stale once
  // freshness has dropped by `freshnessRescoreDelta`; below the floor the video is
  // out of the useful window and no longer needs time-only rescoring.
  let nextRescoreAt: Date | null = null;
  const freshnessNow = 0.5 ** (ageHours / config.freshnessHalfLifeHours);
  if (state !== 'insufficient_evidence' && freshnessNow > config.freshnessRescoreFloor + 1e-9) {
    const target = Math.max(
      freshnessNow - config.freshnessRescoreDelta,
      config.freshnessRescoreFloor,
    );
    const ageAtTarget = config.freshnessHalfLifeHours * Math.log2(1 / target);
    nextRescoreAt = new Date(ageFrom.getTime() + Math.ceil(ageAtTarget * HOUR));
  }

  let rawScore: number | null = null;
  let score: number | null = null;
  if (state !== 'insufficient_evidence') {
    let weighted = 0;
    let weights = 0;
    for (const name of V1_COMPONENT_NAMES) {
      const c = components[name];
      if (!c.available) continue;
      weighted += c.value * c.weight;
      weights += c.weight;
    }
    rawScore = weights > 0 ? round(weighted / weights) : 0;
    score = Math.round(1000 * rawScore * (0.5 + 0.5 * confidence)) / 10;
  }

  for (const name of ['velocity', 'engagement', 'freshness'] as const) {
    const c = components[name];
    if (c.available && c.value >= 0.65)
      reasons.push(
        `${name.toUpperCase()}_${c.strength === 'very strong' ? 'VERY_STRONG' : 'STRONG'}`,
      );
  }

  return {
    algorithmVersion: config.version,
    state,
    score,
    rawScore,
    confidence,
    components,
    reasonCodes: [...new Set(reasons)].sort(),
    missingMetrics,
    growthMetric,
    observations,
    nextRescoreAt,
  };
}
