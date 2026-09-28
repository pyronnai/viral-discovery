import { describe, expect, it } from 'vitest';
import { DEFAULT_SCORING_CONFIG } from './config.ts';
import { evidenceFingerprint } from './fingerprint.ts';
import { explainScore } from './explain.ts';
import { percentile, scoreCandidate } from './score.ts';
import type { CreatorHistoryVideo, ScoringInput, SightingInput, SnapshotInput } from './types.ts';

// Fixed clock: no test depends on the wall clock.
const T0 = Date.parse('2026-09-28T00:00:00Z');
const at = (hours: number) => new Date(T0 + hours * 3_600_000);
const snap = (hours: number, metrics: SnapshotInput['metrics']): SnapshotInput => ({
  capturedAt: at(hours),
  metrics,
});
const sighting = (over: Partial<SightingInput> = {}): SightingInput => ({
  sourceId: 'src-youtube',
  sourceLabel: over.sourceId ?? 'src-youtube',
  role: 'propagation',
  sourcePlatform: 'youtube',
  observationKey: 'mostPopular:US:all',
  runId: 'run-1',
  seenAt: at(0),
  sourceEngagement: null,
  ...over,
});

function input(over: Partial<ScoringInput> = {}): ScoringInput {
  return {
    platform: 'youtube',
    publishedAt: at(-1),
    firstDiscoveredAt: at(0),
    snapshots: [],
    sightings: [sighting()],
    creator: { videos: [] },
    population: { logVelocity: {}, engagementRate: {} },
    asOf: at(2),
    ...over,
  };
}

const views = (v: number, likes?: number, comments?: number) => ({
  views: v,
  likes: likes ?? null,
  comments: comments ?? null,
  shares: null,
});

describe('velocity: breakout beats raw size', () => {
  const small = scoreCandidate(
    input({ snapshots: [snap(0, views(50_000)), snap(2, views(150_000))] }),
  );
  const huge = scoreCandidate(
    input({ snapshots: [snap(0, views(5_000_000)), snap(2, views(5_050_000))] }),
  );

  it('A: 50k → 150k in 2h has a much stronger velocity than B: 5m → 5.05m in 2h', () => {
    expect(small.components.velocity).toMatchObject({
      available: true,
      value: 0.9639,
      strength: 'very strong',
    });
    expect(huge.components.velocity).toMatchObject({
      available: true,
      value: 0.569,
      strength: 'moderate',
    });
    expect(small.score!).toBeGreaterThan(huge.score!);
  });

  it('explains how velocity was computed', () => {
    const c = small.components.velocity;
    expect(c.available && c.details).toMatchObject({
      metric: 'views',
      hours: 2,
      perHour: 50_000,
      relativeGrowthPerHour: 1,
      populationSize: 0,
    });
    expect(c.available && c.normalization).toBe('absolute_fallback');
  });
});

describe('snapshot evidence', () => {
  it('one snapshot: provisional, no velocity, dampened score', () => {
    const r = scoreCandidate(input({ snapshots: [snap(0, views(50_000, 4_000, 300))] }));
    expect(r.state).toBe('provisional');
    expect(r.components.velocity).toMatchObject({
      available: false,
      reason: 'needs 2 snapshots; have 1',
    });
    expect(r.reasonCodes).toContain('SINGLE_SNAPSHOT');
    expect(r.confidence).toBe(0.4); // 0.3 base + 0.05 publish time + 0.05 engagement
    expect(r.score).toBeLessThan(100 * r.rawScore!);
  });

  it('two snapshots: scored, acceleration unavailable', () => {
    const r = scoreCandidate(input({ snapshots: [snap(0, views(1_000)), snap(2, views(5_000))] }));
    expect(r.state).toBe('scored');
    expect(r.components.acceleration).toMatchObject({ available: false });
    expect(r.confidence).toBe(0.65);
  });

  it('snapshots closer than the minimum span do not produce velocity', () => {
    const r = scoreCandidate(
      input({ snapshots: [snap(0, views(1_000)), snap(0.25, views(9_000))] }),
    );
    expect(r.state).toBe('provisional');
    expect(r.reasonCodes).toContain('SNAPSHOTS_TOO_CLOSE');
  });

  it('three spaced snapshots: accelerating vs decelerating', () => {
    const accel = scoreCandidate(
      input({
        asOf: at(4),
        snapshots: [snap(0, views(1_000)), snap(2, views(3_000)), snap(4, views(11_000))],
      }),
    );
    expect(accel.components.acceleration).toMatchObject({
      available: true,
      value: 1,
      details: { ratio: 4 },
    });
    expect(accel.reasonCodes).toContain('ACCELERATING');
    expect(accel.confidence).toBe(0.8);

    const decel = scoreCandidate(
      input({
        asOf: at(4),
        snapshots: [snap(0, views(1_000)), snap(2, views(9_000)), snap(4, views(11_000))],
      }),
    );
    expect(decel.components.acceleration).toMatchObject({
      available: true,
      value: 0,
      details: { ratio: 0.25 },
    });
    expect(decel.reasonCodes).toContain('DECELERATING');
    expect(accel.score!).toBeGreaterThan(decel.score!);
  });

  it('never reports negative growth; a decreasing count is flagged', () => {
    const r = scoreCandidate(input({ snapshots: [snap(0, views(10_000)), snap(2, views(9_000))] }));
    expect(r.components.velocity).toMatchObject({ available: true, details: { perHour: 0 } });
    expect(r.reasonCodes).toContain('METRIC_DECREASED');
  });
});

describe('freshness', () => {
  const growth = [snap(0, views(10_000)), snap(2, views(30_000))];
  it('a fresh video outranks an old one with identical counts', () => {
    const fresh = scoreCandidate(input({ snapshots: growth, publishedAt: at(-2) }));
    const old = scoreCandidate(input({ snapshots: growth, publishedAt: at(-24 * 30) }));
    expect(fresh.components.freshness).toMatchObject({ available: true, strength: 'very strong' });
    expect(old.components.freshness).toMatchObject({ available: true, strength: 'very weak' });
    expect(fresh.score!).toBeGreaterThan(old.score!);
  });

  it('falls back to discovery time, flags it, and lowers confidence', () => {
    const r = scoreCandidate(input({ snapshots: growth, publishedAt: null }));
    expect(r.components.freshness).toMatchObject({
      details: { ageFrom: 'first_discovered_at (lower bound on true age)' },
    });
    expect(r.reasonCodes).toContain('AGE_FROM_DISCOVERY_TIME');
    expect(r.confidence).toBe(0.6);
  });
});

describe('missing metrics are not punished', () => {
  it('views only (no likes/comments): engagement is unavailable, not zero', () => {
    const r = scoreCandidate(input({ snapshots: [snap(0, views(1_000)), snap(2, views(9_000))] }));
    expect(r.components.engagement).toMatchObject({
      available: false,
      reason: 'no likes/comments/shares supplied',
    });
    expect(r.missingMetrics).toEqual(expect.arrayContaining(['likes', 'comments', 'shares']));
    const withWeak = scoreCandidate(
      input({ snapshots: [snap(0, views(1_000, 0, 0)), snap(2, views(9_000, 0, 0))] }),
    );
    // Zero engagement is a real (bad) signal; missing engagement is not.
    expect(r.score!).toBeGreaterThan(withWeak.score!);
  });

  it('uses only the engagement metrics that were supplied', () => {
    const r = scoreCandidate(
      input({ snapshots: [snap(0, views(10_000, 500)), snap(2, views(20_000, 1_000))] }),
    );
    const c = r.components.engagement;
    expect(c.available && Object.keys(c.details['rates'] as object)).toEqual(['likes']);
    expect(c.available && c.value).toBe(1); // 5% like rate == reference
  });

  it('no view metric: likes become the growth metric (e.g. native Bluesky video)', () => {
    const r = scoreCandidate(
      input({
        platform: 'bluesky',
        snapshots: [
          snap(0, { views: null, likes: 100, comments: 5 }),
          snap(2, { views: null, likes: 900, comments: 20 }),
        ],
        sightings: [
          sighting({
            sourceId: 'src-bsky',
            sourcePlatform: 'bluesky',
            sourceEngagement: { likes: 900, reposts: 50, replies: 20, quotes: 1 },
          }),
        ],
      }),
    );
    expect(r.growthMetric).toBe('likes');
    expect(r.reasonCodes).toContain('NO_VIEW_METRIC');
    expect(r.components.velocity).toMatchObject({
      available: true,
      details: { metric: 'likes', perHour: 400 },
    });
    expect(r.components.engagement).toMatchObject({ available: false });
    // Its own post IS the video: no double counting as "propagation".
    expect(r.components.sourcePropagation).toMatchObject({ available: false });
  });

  it('no canonical metrics at all (manual TikTok): insufficient evidence, no score value', () => {
    const r = scoreCandidate(
      input({
        platform: 'tiktok',
        publishedAt: null,
        snapshots: [],
        sightings: [
          sighting({
            sourceId: 'src-manual',
            sourcePlatform: 'manual',
            observationKey: 'tiktok:1',
          }),
          sighting({
            sourceId: 'src-bsky',
            sourcePlatform: 'bluesky',
            observationKey: 'at://post1',
            sourceEngagement: { likes: 300, reposts: 40, replies: 10, quotes: 2 },
          }),
        ],
      }),
    );
    expect(r).toMatchObject({
      state: 'insufficient_evidence',
      score: null,
      rawScore: null,
      confidence: 0,
    });
    expect(r.reasonCodes).toContain('NO_CANONICAL_METRICS');
    // Evidence is still recorded for the review feed.
    expect(r.components.crossSource).toMatchObject({
      available: true,
      details: { distinctSources: 2 },
    });
    expect(r.components.sourcePropagation).toMatchObject({
      available: true,
      basis: 'source_propagation',
    });
  });
});

describe('cross-source evidence', () => {
  const growth = [snap(0, views(10_000)), snap(2, views(30_000))];

  it('independent sources strengthen the signal', () => {
    const one = scoreCandidate(input({ snapshots: growth }));
    const three = scoreCandidate(
      input({
        snapshots: growth,
        sightings: [
          sighting(),
          sighting({ sourceId: 'src-bsky', sourcePlatform: 'bluesky', observationKey: 'at://p1' }),
          sighting({ sourceId: 'src-bsky', sourcePlatform: 'bluesky', observationKey: 'at://p2' }),
          sighting({
            sourceId: 'src-manual',
            sourcePlatform: 'manual',
            observationKey: 'youtube:x',
          }),
        ],
      }),
    );
    expect(one.components.crossSource).toMatchObject({ available: true, value: 0 });
    expect(three.components.crossSource).toMatchObject({
      available: true,
      value: 0.8,
      details: { distinctSources: 3, independentObservations: 4 },
    });
    expect(three.reasonCodes).toContain('CROSS_SOURCE_3');
    expect(three.score!).toBeGreaterThan(one.score!);
  });

  it('repeat observations of the same thing (same run or later runs) do not inflate it', () => {
    const repeats = Array.from({ length: 10 }, (_, i) =>
      sighting({ runId: `run-${i}`, seenAt: at(i / 10) }),
    );
    const r = scoreCandidate(input({ snapshots: growth, sightings: repeats }));
    expect(r.components.crossSource).toMatchObject({
      value: 0,
      details: { distinctSources: 1, independentObservations: 1, totalSightings: 10 },
    });
  });
});

describe('source-context engagement is isolated from canonical metrics', () => {
  const growth = [snap(0, views(10_000, 400, 20)), snap(2, views(30_000, 1_200, 60))];
  const post = (key: string, likes: number, seenAt = at(1)) =>
    sighting({
      sourceId: 'src-bsky',
      sourcePlatform: 'bluesky',
      observationKey: key,
      seenAt,
      sourceEngagement: { likes, reposts: 10, replies: 5, quotes: 0 },
    });

  it('appears only as the source-propagation component', () => {
    const without = scoreCandidate(input({ snapshots: growth }));
    const withPosts = scoreCandidate(
      input({
        snapshots: growth,
        sightings: [sighting(), post('at://p1', 800), post('at://p2', 100)],
      }),
    );
    expect(withPosts.components.engagement).toEqual(without.components.engagement);
    expect(withPosts.components.velocity).toEqual(without.components.velocity);
    expect(withPosts.components.sourcePropagation).toMatchObject({
      available: true,
      basis: 'source_propagation',
      details: { items: 2, likes: 900, reposts: 20, replies: 10, interactions: 930 },
    });
    expect(without.components.sourcePropagation).toMatchObject({ available: false });
  });

  it('counts each source item once, using its latest observation', () => {
    const r = scoreCandidate(
      input({
        snapshots: growth,
        sightings: [post('at://p1', 50, at(0.5)), post('at://p1', 800, at(1.5))],
      }),
    );
    expect(r.components.sourcePropagation).toMatchObject({ details: { items: 1, likes: 800 } });
  });
});

describe('creator outlier (age-matched)', () => {
  // Candidate: published at -2h, 50k views at +2h → age 4h. Window = max(1h, 25% × 4h) = ±1h.
  const candidate = {
    publishedAt: at(-2),
    snapshots: [snap(0, views(20_000)), snap(2, views(50_000))],
  };
  /** A historical video published `publishedDaysAgo` days before T0 with readings at the given ages (hours). */
  const history = (
    publishedDaysAgo: number,
    readings: [ageHours: number, value: number][],
  ): CreatorHistoryVideo => {
    const published = at(-24 * publishedDaysAgo);
    return {
      publishedAt: published,
      snapshots: readings.map(([age, value]) => ({
        capturedAt: new Date(published.getTime() + age * 3_600_000),
        value,
      })),
    };
  };

  it('A: 50k at 4h vs a creator who usually has 5k–8k around 4h → strong outlier', () => {
    const r = scoreCandidate(
      input({
        ...candidate,
        creator: {
          videos: [
            history(10, [
              [4, 5_000],
              [24, 20_000],
            ]),
            history(20, [[3.5, 6_000]]),
            history(30, [[4.5, 7_000]]),
            history(40, [[4.2, 8_000]]),
            history(50, [[3.2, 6_500]]),
            history(60, [[3.9, 5_500]]),
          ],
        },
      }),
    );
    expect(r.components.creatorOutlier).toMatchObject({
      available: true,
      strength: 'strong',
      details: {
        targetAgeHours: 4,
        windowHours: 1,
        ageMatched: 6,
        baselineMedian: 6_250,
        ratio: 8,
      },
    });
    expect(r.reasonCodes).toContain('CREATOR_OUTLIER');
  });

  it('B: creator history only has 7-day-old readings → unavailable, never compared directly', () => {
    const r = scoreCandidate(
      input({
        ...candidate,
        creator: { videos: [10, 20, 30, 40, 50, 60].map((d) => history(d, [[168, 5_000]])) },
      }),
    );
    expect(r.components.creatorOutlier).toMatchObject({
      available: false,
      reason:
        'insufficient age-matched creator history: 0 of 6 other videos have a reading within ±1h of age 4h (need 5)',
      details: { ageMatched: 0, creatorVideos: 6, withPublishTime: 6 },
    });
    expect(r.reasonCodes).toContain('CREATOR_BASELINE_UNAVAILABLE');
  });

  it('C: creator routinely has 100k around 4h → not an outlier', () => {
    const r = scoreCandidate(
      input({
        ...candidate,
        creator: {
          videos: [10, 20, 30, 40, 50].map((d, i) => history(d, [[3.5 + i * 0.2, 100_000]])),
        },
      }),
    );
    expect(r.components.creatorOutlier).toMatchObject({
      available: true,
      value: 0,
      strength: 'very weak',
      details: { ratio: 0.5 },
    });
    expect(r.reasonCodes).not.toContain('CREATOR_OUTLIER');
  });

  it('picks the nearest reading inside the window and never interpolates across a gap', () => {
    const nearest = scoreCandidate(
      input({
        ...candidate,
        creator: {
          videos: [1, 2, 3, 4, 5].map((d) =>
            history(d, [
              [3.1, 1_000],
              [4.1, 9_000],
              [4.9, 2_000],
            ]),
          ),
        },
      }),
    );
    expect(nearest.components.creatorOutlier).toMatchObject({
      available: true,
      details: { baselineMedian: 9_000 },
    });
    // Readings at 1h and 8h bracket 4h but are outside ±1h: no interpolated baseline.
    const gap = scoreCandidate(
      input({
        ...candidate,
        creator: {
          videos: [1, 2, 3, 4, 5].map((d) =>
            history(d, [
              [1, 1_000],
              [8, 9_000],
            ]),
          ),
        },
      }),
    );
    expect(gap.components.creatorOutlier).toMatchObject({
      available: false,
      details: { ageMatched: 0 },
    });
  });

  it('is unavailable without publish times or a creator, with the reason exposed', () => {
    const noCandidatePublish = scoreCandidate(
      input({ ...candidate, publishedAt: null, creator: { videos: [] } }),
    );
    expect(noCandidatePublish.components.creatorOutlier).toMatchObject({
      available: false,
      reason: 'candidate publish time unknown; cannot age-match',
    });
    const noHistoryPublish = scoreCandidate(
      input({
        ...candidate,
        creator: {
          videos: [1, 2, 3, 4, 5].map(() => ({
            publishedAt: null,
            snapshots: [{ capturedAt: at(0), value: 5_000 }],
          })),
        },
      }),
    );
    expect(noHistoryPublish.components.creatorOutlier).toMatchObject({
      available: false,
      details: { withPublishTime: 0 },
    });
    expect(
      scoreCandidate(input({ ...candidate, creator: null })).components.creatorOutlier,
    ).toMatchObject({
      available: false,
      reason: 'no creator identity',
    });
  });
});

describe('platform normalization', () => {
  const growth = [snap(0, views(10_000)), snap(2, views(30_000))];
  it('uses the absolute fallback for a small sample and says so', () => {
    const r = scoreCandidate(
      input({
        snapshots: growth,
        population: { logVelocity: { views: [1, 2, 3, 4, 5] }, engagementRate: {} },
      }),
    );
    expect(r.components.velocity).toMatchObject({
      normalization: 'absolute_fallback',
      details: { populationSize: 5 },
    });
    expect(r.reasonCodes).toContain('VELOCITY_NORMALIZATION_FALLBACK');
  });

  it('uses the platform percentile once the sample is large enough, raising confidence', () => {
    // 40 prior videos with log velocities 0.2 … 8.0; this video: log10(1 + 10,000/h) ≈ 4.00004,
    // above exactly 20 of them → median.
    const sample = Array.from({ length: 40 }, (_, i) => (i + 1) / 5);
    const r = scoreCandidate(
      input({
        snapshots: growth,
        population: { logVelocity: { views: sample }, engagementRate: {} },
      }),
    );
    expect(r.components.velocity).toMatchObject({
      normalization: 'platform_percentile',
      details: { absoluteNorm: 0.5 },
    });
    expect(r.confidence).toBe(0.75);
    expect(r.reasonCodes).not.toContain('VELOCITY_NORMALIZATION_FALLBACK');
  });

  it('percentile uses mid-ranks', () => {
    expect(percentile([1, 2, 3, 4], 2.5)).toBe(0.5);
    expect(percentile([1, 2, 2, 3], 2)).toBe(0.5);
    expect(percentile([], 1)).toBe(0);
  });
});

describe('versioning and determinism', () => {
  const base = input({
    snapshots: [snap(0, views(10_000, 500, 20)), snap(2, views(30_000, 1_500, 60))],
  });

  it('records the algorithm version; a different config is a different version and fingerprint', () => {
    const config = {
      ...DEFAULT_SCORING_CONFIG,
      version: 'breakout-v1-test',
      freshnessHalfLifeHours: 12,
    };
    expect(scoreCandidate(base).algorithmVersion).toBe('breakout-v1.1');
    expect(scoreCandidate(base, config).algorithmVersion).toBe('breakout-v1-test');
    expect(evidenceFingerprint(base, config)).not.toBe(
      evidenceFingerprint(base, DEFAULT_SCORING_CONFIG),
    );
  });

  it('is deterministic: same evidence, same result and fingerprint', () => {
    expect(scoreCandidate(base)).toEqual(scoreCandidate(structuredClone(base)));
    const reordered = {
      ...base,
      snapshots: [...base.snapshots].reverse(),
      sightings: [...base.sightings].reverse(),
    };
    expect(evidenceFingerprint(reordered, DEFAULT_SCORING_CONFIG)).toBe(
      evidenceFingerprint(base, DEFAULT_SCORING_CONFIG),
    );
  });

  it('ignores evidence after asOf, so past scores can be recalculated exactly', () => {
    const later = { ...base, snapshots: [...base.snapshots, snap(5, views(1_000_000))] };
    expect(scoreCandidate(later)).toEqual(scoreCandidate(base));
    expect(evidenceFingerprint(later, DEFAULT_SCORING_CONFIG)).toBe(
      evidenceFingerprint(base, DEFAULT_SCORING_CONFIG),
    );
  });

  it('new evidence changes the fingerprint', () => {
    const more = {
      ...base,
      sightings: [...base.sightings, sighting({ sourceId: 'src-bsky', observationKey: 'at://p9' })],
    };
    expect(evidenceFingerprint(more, DEFAULT_SCORING_CONFIG)).not.toBe(
      evidenceFingerprint(base, DEFAULT_SCORING_CONFIG),
    );
  });

  it('renders an explanation', () => {
    const lines = explainScore(scoreCandidate(base));
    expect(lines[0]).toMatch(
      /^Virality score: \d+(\.\d)? \(scored; confidence 0\.7; breakout-v1\.1\)$/,
    );
    expect(lines.join('\n')).toMatch(
      /creator outlier: unavailable \(insufficient age-matched creator history/,
    );
  });
});

describe('manual submissions are not propagation evidence', () => {
  const growth = [snap(0, views(12_000, 900, 60)), snap(2, views(48_000, 3_900, 240))];
  const publicSightings = [
    sighting({ sourceId: 'youtube' }),
    sighting({
      sourceId: 'bluesky',
      sourcePlatform: 'bluesky',
      observationKey: 'at://p1',
      sourceEngagement: { likes: 420, reposts: 95, replies: 30, quotes: 6 },
    }),
    sighting({
      sourceId: 'bluesky',
      sourcePlatform: 'bluesky',
      observationKey: 'at://p2',
      sourceEngagement: { likes: 130, reposts: 22, replies: 8, quotes: 1 },
    }),
  ];
  const manual = (i: number) =>
    sighting({
      sourceId: 'manual-url',
      role: 'provenance',
      sourcePlatform: 'manual',
      observationKey: `youtube:x#${i}`,
      seenAt: at(1 + i / 100),
    });

  it('ten manual submissions cannot increase any propagation signal or the score', () => {
    const base = scoreCandidate(input({ snapshots: growth, sightings: publicSightings }));
    const withManual = scoreCandidate(
      input({
        snapshots: growth,
        sightings: [...publicSightings, ...Array.from({ length: 10 }, (_, i) => manual(i))],
      }),
    );
    expect(withManual.score).toBe(base.score);
    expect(withManual.confidence).toBe(base.confidence);
    expect(withManual.components.sourcePropagation).toEqual(base.components.sourcePropagation);
    expect(
      withManual.components.crossSource.available && withManual.components.crossSource.value,
    ).toBe(base.components.crossSource.available && base.components.crossSource.value);
    expect(withManual.components.crossSource).toMatchObject({
      details: {
        distinctSources: 2,
        independentObservations: 3,
        publicSources: ['bluesky', 'youtube'],
        nonPropagationObservations: [{ source: 'manual-url', observations: 10 }],
      },
    });
    expect(withManual.observations).toEqual({
      publicPropagation: [
        { source: 'bluesky', observations: 2 },
        { source: 'youtube', observations: 1 },
      ],
      nonPropagation: [{ source: 'manual-url', observations: 10 }],
    });
    expect(withManual.reasonCodes).toContain('NON_PROPAGATION_OBSERVATIONS');
    expect(withManual.reasonCodes).toContain('CROSS_SOURCE_2');
    expect(withManual.reasonCodes).not.toContain('CROSS_SOURCE_3');
  });

  it('a manual-only video has zero cross-source evidence (not "unavailable", which would help it)', () => {
    const r = scoreCandidate(input({ snapshots: growth, sightings: [manual(0)] }));
    expect(r.components.crossSource).toMatchObject({
      available: true,
      value: 0,
      details: { distinctSources: 0 },
    });
  });

  it('provenance sightings never contribute source engagement', () => {
    const withEngagement = {
      ...manual(0),
      sourceEngagement: { likes: 10_000, reposts: 10_000, replies: 0, quotes: 0 },
    };
    const r = scoreCandidate(input({ snapshots: growth, sightings: [sighting(), withEngagement] }));
    expect(r.components.sourcePropagation).toMatchObject({ available: false });
  });

  it('explains public propagation and non-propagation observations separately', () => {
    const lines = explainScore(
      scoreCandidate(input({ snapshots: growth, sightings: [...publicSightings, manual(0)] })),
    ).join('\n');
    expect(lines).toMatch(/public propagation sources: bluesky ×2, youtube ×1/);
    expect(lines).toMatch(/non-propagation observations: manual-url ×1 \(not counted as spread\)/);
  });
});

describe('time-based staleness', () => {
  const growth = [snap(0, views(10_000)), snap(2, views(30_000))];

  it('a fresh video scores lower later with the same evidence', () => {
    const now = scoreCandidate(input({ snapshots: growth, asOf: at(2) }));
    const later = scoreCandidate(input({ snapshots: growth, asOf: at(26) }));
    expect(later.score!).toBeLessThan(now.score!);
    expect(later.components.freshness.available && later.components.freshness.value).toBeLessThan(
      (now.components.freshness.available && now.components.freshness.value) || 0,
    );
  });

  it('schedules the next rescore when freshness will have dropped by the configured delta', () => {
    const r = scoreCandidate(input({ snapshots: growth, asOf: at(2) }));
    // Age 3h → freshness 0.9439; target 0.8939 → age 36 × log2(1/0.8939) ≈ 5.83h → at(-1) + 5.83h.
    expect(r.nextRescoreAt!.getTime()).toBeGreaterThan(at(4.8).getTime());
    expect(r.nextRescoreAt!.getTime()).toBeLessThan(at(4.9).getTime());
  });

  it('ages out: no time-only rescoring once freshness is below the floor', () => {
    const old = scoreCandidate(input({ snapshots: growth, publishedAt: at(-24 * 8), asOf: at(2) }));
    expect(old.nextRescoreAt).toBeNull();
    // The last scheduled step lands exactly on the floor, after which scheduling stops.
    const nearFloor = scoreCandidate(
      input({ snapshots: growth, publishedAt: at(-150), asOf: at(2) }),
    );
    const age = (nearFloor.nextRescoreAt!.getTime() - at(-150).getTime()) / 3_600_000;
    expect(0.5 ** (age / 36)).toBeCloseTo(0.05, 3);
    const atFloor = scoreCandidate(
      input({ snapshots: growth, publishedAt: at(-150), asOf: nearFloor.nextRescoreAt! }),
    );
    expect(atFloor.nextRescoreAt).toBeNull();
  });

  it('insufficient evidence never needs time-only rescoring', () => {
    expect(scoreCandidate(input({ snapshots: [] })).nextRescoreAt).toBeNull();
  });
});
