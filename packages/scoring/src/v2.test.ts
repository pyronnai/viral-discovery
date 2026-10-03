import { describe, expect, it } from 'vitest';
import type { ScoreResult, ScoringInput, SightingInput } from './types.ts';
import { DEFAULT_SCORING_CONFIG, scoreCandidate } from './v2.ts';
import { explainScore } from './explain.ts';

/**
 * Fixed-time cases for breakout-v2. Assertions are about ORDER and STATE (what a
 * person would call a breakout), not exact score numbers.
 */
const NOW = new Date('2026-10-03T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

interface Spec {
  platform?: string;
  /** Age at NOW in hours; null = publish time unknown. */
  ageHours: number | null;
  /** [hours before NOW, views] readings; likes-only platforms use `likes`. */
  views?: [number, number][];
  likes?: [number, number][];
  discoveredHoursAgo?: number;
  sightings?: SightingInput[];
}

function input(spec: Spec): ScoringInput {
  const readings = new Map<number, { views?: number; likes?: number }>();
  for (const [h, v] of spec.views ?? []) readings.set(h, { ...readings.get(h), views: v });
  for (const [h, v] of spec.likes ?? []) readings.set(h, { ...readings.get(h), likes: v });
  return {
    platform: spec.platform ?? 'youtube',
    publishedAt: spec.ageHours === null ? null : hoursAgo(spec.ageHours),
    firstDiscoveredAt: hoursAgo(spec.discoveredHoursAgo ?? Math.max(...[...readings.keys(), 0])),
    snapshots: [...readings.entries()].map(([h, m]) => ({
      capturedAt: hoursAgo(h),
      metrics: { views: m.views ?? null, likes: m.likes ?? null },
    })),
    sightings: spec.sightings ?? [
      {
        sourceId: 's1',
        sourceLabel: spec.platform ?? 'youtube',
        role: 'propagation',
        sourcePlatform: spec.platform ?? 'youtube',
        observationKey: 'k',
        runId: null,
        seenAt: hoursAgo(0),
        sourceEngagement: null,
      },
    ],
    creator: null,
    population: { logVelocity: {}, engagementRate: {} },
    asOf: NOW,
  };
}
const score = (spec: Spec) => scoreCandidate(input(spec));
const first = (platform: string, views: number, ageHours: number) =>
  score({ platform, ageHours, views: [[0, views]] });
const value = (r: ScoreResult) => r.score ?? -1;

describe('breakout-v2: first-snapshot evidence', () => {
  it('1. 845k views at 16h on the first snapshot is a strong, eligible breakout', () => {
    const r = first('youtube', 845_000, 16);
    expect(r.state).toBe('provisional');
    expect(r.score).toBeGreaterThanOrEqual(80);
    expect(r.viralNow?.evidence).toBe(true);
    // Confidence is reported, not multiplied in.
    expect(r.confidence).toBeLessThan(0.75);
  });

  it('2. 50k views at 1h is potentially very strong already', () => {
    const r = first('youtube', 50_000, 1);
    expect(r.state).toBe('provisional');
    expect(r.score).toBeGreaterThanOrEqual(65);
    expect(r.viralNow?.evidence).toBe(true);
  });

  it('3. ~800 views at 0.8h does not outrank 845k at 16h just for being newer', () => {
    const big = first('youtube', 845_000, 16);
    const youtubeSmall = first('youtube', 805, 0.8);
    const twitchSmall = first('twitch', 805, 0.8);
    expect(value(youtubeSmall)).toBeLessThan(value(big) - 40);
    expect(value(twitchSmall)).toBeLessThan(value(big) - 25);
    // The pace floor keeps a sub-hour age from inflating the rate.
    expect(
      youtubeSmall.components.pace.available && youtubeSmall.components.pace.details['perHour'],
    ).toBe(805);
  });

  it('4. 200 views at 10 minutes is fresh but insufficient evidence', () => {
    const r = first('youtube', 200, 1 / 6);
    expect(r.state).toBe('insufficient_evidence');
    expect(r.score).toBeNull();
    expect(r.viralNow?.evidence).toBe(false);
    expect(r.reasonCodes).toContain('REACH_BELOW_MINIMUM');
  });

  it('5. 5M views at 10 days is large reach but not "viral now"', () => {
    const r = first('youtube', 5_000_000, 240);
    expect(r.state).toBe('provisional');
    expect(value(r)).toBeLessThan(DEFAULT_SCORING_CONFIG.viralNow.minScore);
    expect(r.viralNow).toMatchObject({ evidence: false, revival: false });
  });

  it('6. a metric-less Bluesky post at 20 minutes has no viral evidence', () => {
    const noMetrics = score({ platform: 'bluesky', ageHours: 1 / 3, likes: [] });
    expect(noMetrics.state).toBe('insufficient_evidence');
    const zeroLikes = score({ platform: 'bluesky', ageHours: 1 / 3, likes: [[0, 0]] });
    expect(zeroLikes.state).toBe('insufficient_evidence');
    expect(zeroLikes.score).toBeNull();
    expect(zeroLikes.viralNow?.evidence).toBe(false);
    // Measuring a post nobody engages with again is still no evidence.
    const watched = score({
      platform: 'bluesky',
      ageHours: 3,
      likes: [
        [2, 0],
        [0, 3],
      ],
    });
    expect(watched.components.velocity.available).toBe(true);
    expect(watched.state).toBe('insufficient_evidence');
    expect(watched.score).toBeNull();
  });
});

describe('breakout-v2: measured trajectory refines the estimate', () => {
  // First snapshot: 100k views at 4h old (25k/h lifetime pace), refreshed +2h later.
  const base: Spec = { ageHours: 6, views: [[2, 100_000]] };
  const firstOnly = scoreCandidate({ ...input(base), asOf: hoursAgo(2) });

  it('7. strong +2h growth keeps or raises the score and reads as accelerating', () => {
    const r = score({
      ...base,
      views: [
        [2, 100_000],
        [0, 220_000],
      ],
    });
    expect(r.state).toBe('scored');
    expect(value(r)).toBeGreaterThanOrEqual(value(firstOnly));
    expect(r.reasonCodes).toContain('ACCELERATING');
    // ≈ half measured after +2h: a smooth transition, not a jump.
    const share = r.components.momentum.available && r.components.momentum.details['observedShare'];
    expect(share).toBeCloseTo(0.5, 1);
  });

  it('8. weak +2h growth lowers the score', () => {
    const r = score({
      ...base,
      views: [
        [2, 100_000],
        [0, 104_000],
      ],
    });
    expect(r.state).toBe('scored');
    expect(value(r)).toBeLessThan(value(firstOnly));
    expect(r.reasonCodes).toContain('DECELERATING');
  });

  it('9. flat or negative growth lowers it further, and measurement becomes authoritative over time', () => {
    const weak = score({
      ...base,
      views: [
        [2, 100_000],
        [0, 104_000],
      ],
    });
    const flat = score({
      ...base,
      views: [
        [2, 100_000],
        [0, 100_000],
      ],
    });
    const negative = score({
      ...base,
      views: [
        [2, 100_000],
        [0, 99_000],
      ],
    });
    expect(value(flat)).toBeLessThan(value(weak));
    // A decrease is no growth (slightly less reach, so at most the flat score).
    expect(value(negative)).toBeLessThanOrEqual(value(flat));
    expect(negative.reasonCodes).toContain('METRIC_DECREASED');
    // A full day of flat measurements outweighs the strong first impression.
    const dayFlat = score({
      ageHours: 28,
      views: [
        [24, 100_000],
        [16, 100_500],
        [0, 101_000],
      ],
    });
    expect(value(dayFlat)).toBeLessThan(value(flat));
  });

  it('10. missing publish time: no inferred pace; scored once velocity is measured', () => {
    const single = score({ ageHours: null, views: [[0, 500_000]], discoveredHoursAgo: 0 });
    expect(single.state).toBe('insufficient_evidence');
    expect(single.components.pace.available).toBe(false);
    const measured = score({
      ageHours: null,
      views: [
        [2, 500_000],
        [0, 700_000],
      ],
    });
    expect(measured.state).toBe('scored');
    expect(measured.components.pace.available).toBe(false);
    expect(measured.viralNow?.evidence).toBe(true);
  });
});

describe('breakout-v2: platform normalization and reach', () => {
  it('11. a few hundred Twitch views do not compete with 800k YouTube; a big Twitch clip does', () => {
    const youtube = first('youtube', 800_000, 16);
    const smallClip = first('twitch', 600, 1);
    const bigClip = first('twitch', 20_000, 2);
    expect(value(smallClip)).toBeLessThan(value(youtube) - 25);
    expect(value(bigClip)).toBeGreaterThan(value(smallClip) + 25);
    expect(value(bigClip)).toBeGreaterThanOrEqual(75);
    // The same counts on YouTube's scale are weaker evidence than on Twitch's.
    expect(value(first('youtube', 20_000, 2))).toBeLessThan(value(bigClip));
  });

  it('12. huge total views but stale ranks below a modest, fresh breakout', () => {
    const stale = first('youtube', 20_000_000, 5 * 24);
    const fresh = first('youtube', 120_000, 6);
    expect(value(stale)).toBeLessThan(value(fresh));
    // Outside the Viral Now window (applied by the inbox) and no measured revival.
    const ageHours = stale.components.age.available ? stale.components.age.details['ageHours'] : 0;
    expect(ageHours).toBeGreaterThan(DEFAULT_SCORING_CONFIG.viralNow.windowHours);
    expect(stale.viralNow?.revival).toBe(false);
  });

  it('13. modest totals that are explosive for their age outrank bigger, slower videos', () => {
    const explosive = first('youtube', 30_000, 0.75);
    const slower = first('youtube', 107_000, 21);
    expect(value(explosive)).toBeGreaterThan(value(slower));
  });

  it('reach stays in the core after velocity is measured', () => {
    // Publish time unknown ⇒ pace core = measured velocity only, identical here (10k/h).
    const small = score({
      ageHours: null,
      views: [
        [2, 1_000],
        [0, 21_000],
      ],
    });
    const large = score({
      ageHours: null,
      views: [
        [2, 1_000_000],
        [0, 1_020_000],
      ],
    });
    const core = (r: ScoreResult) =>
      r.components.momentum.available ? r.components.momentum.details['paceCore'] : null;
    expect(core(small)).toBe(core(large));
    expect(value(large)).toBeGreaterThan(value(small) + 10);
  });

  it('a tiny video with one brief burst does not outrank a large accelerating breakout', () => {
    const burst = score({
      ageHours: 3,
      views: [
        [1, 300],
        [0, 5_300],
      ],
    });
    const breakout = score({
      ageHours: 12,
      views: [
        [2, 500_000],
        [0, 700_000],
      ],
    });
    expect(burst.state).toBe('scored');
    expect(value(breakout)).toBeGreaterThan(value(burst));
  });
});

describe('breakout-v2: Viral Now evidence and revival', () => {
  it('an old video is not eligible unless measured velocity shows a genuine revival', () => {
    // Its ordinary long tail (2.5k/h, far below its lifetime pace) is not a revival …
    const quiet = score({
      ageHours: 10 * 24,
      views: [
        [4, 5_000_000],
        [0, 5_010_000],
      ],
    });
    expect(quiet.viralNow?.revival).toBe(false);
    expect(quiet.reasonCodes).toContain('DECELERATING');
    // … renewed momentum (100k/h, above its lifetime pace) is.
    const revived = score({
      ageHours: 10 * 24,
      views: [
        [4, 5_000_000],
        [0, 5_400_000],
      ],
    });
    expect(revived.viralNow?.revival).toBe(true);
    expect(value(revived)).toBeGreaterThan(value(quiet));
  });

  it('exposes the configured window, and explains itself', () => {
    const r = first('youtube', 845_000, 16);
    expect(r.viralNow?.windowHours).toBe(48);
    const custom = scoreCandidate(input({ ageHours: 16, views: [[0, 845_000]] }), {
      ...DEFAULT_SCORING_CONFIG,
      viralNow: { ...DEFAULT_SCORING_CONFIG.viralNow, windowHours: 24 },
    });
    expect(custom.viralNow?.windowHours).toBe(24);
    const text = explainScore(r).join('\n');
    expect(text).toMatch(/inferred pace .*\/h at 16h old/);
    expect(text).toMatch(/viral now: eligible on evidence/);
  });

  it('a platform percentile is blended in smoothly once a population exists', () => {
    const base = input({ ageHours: 16, views: [[0, 845_000]] });
    const none = scoreCandidate(base);
    const small = scoreCandidate({
      ...base,
      population: {
        logVelocity: {},
        engagementRate: {},
        logPace: { views: Array.from({ length: 30 }, () => 6) },
      },
    });
    const full = scoreCandidate({
      ...base,
      population: {
        logVelocity: {},
        engagementRate: {},
        logPace: { views: Array.from({ length: 100 }, () => 6) },
      },
    });
    // At the minimum population the percentile has no weight yet (no discontinuity) …
    expect(small.score).toBe(none.score);
    // … and at most half the weight once the population is large.
    const pace = full.components.pace.available ? full.components.pace.details : {};
    expect(pace['percentileShare']).toBe(0.5);
    expect(value(full)).toBeLessThan(value(none));
  });

  it('soft-caps instead of clipping, so strong candidates stay ordered below 100', () => {
    const strong = first('youtube', 845_000, 16);
    const stronger = first('youtube', 2_500_000, 16);
    expect(value(stronger)).toBeGreaterThan(value(strong));
    expect(value(stronger)).toBeLessThan(100);
  });

  it('is deterministic and never reads a clock', () => {
    const a = first('youtube', 845_000, 16);
    expect(first('youtube', 845_000, 16)).toEqual(a);
    expect(a.algorithmVersion).toBe('breakout-v2');
  });

  it('schedules a time-only rescore as the age discount decays', () => {
    const young = first('youtube', 845_000, 16);
    // Grace ends at 24h, then the next 0.05 drop of the age discount.
    expect(young.nextRescoreAt!.getTime()).toBeGreaterThan(hoursAgo(-8).getTime());
    expect(first('youtube', 200, 1 / 6).nextRescoreAt).toBeNull();
  });
});

describe('breakout-v2: TikTok fallback scales (initial, versioned)', () => {
  const tiktok = (views: number, ageHours: number) => first('tiktok', views, ageHours);
  const scaleOf = (r: ScoreResult, c: 'pace' | 'reach') =>
    r.components[c].available ? r.components[c].details : {};

  it("1. TikTok uses its own fallback, not YouTube's", () => {
    const { scales } = DEFAULT_SCORING_CONFIG;
    expect(scales['tiktok']).toBeDefined();
    expect(scales['tiktok']).not.toEqual(scales['youtube']);
    expect(scales['tiktok']!.pace.views[0]).toBeCloseTo(Math.log10(51), 10);
    expect(scales['tiktok']!.pace.views[1]).toBeCloseTo(Math.log10(200_001), 10);
    expect(scales['tiktok']!.reach.views[0]).toBeCloseTo(Math.log10(1_001), 10);
    expect(scales['tiktok']!.reach.views[1]).toBeCloseTo(Math.log10(10_000_001), 10);
    // Same counts, different scale ⇒ different normalized evidence.
    const onTikTok = tiktok(100_000, 10);
    const onYouTube = first('youtube', 100_000, 10);
    expect(scaleOf(onTikTok, 'reach')['scale']).toEqual([...scales['tiktok']!.reach.views]);
    expect(onTikTok.components.reach).not.toEqual(onYouTube.components.reach);
    expect(value(onTikTok)).toBeLessThan(value(onYouTube));
  });

  it('2. a large, fast TikTok ranks strongly from its first snapshot', () => {
    const r = tiktok(1_000_000, 10);
    expect(r.state).toBe('provisional');
    expect(r.viralNow?.evidence).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(70);
  });

  it('3. a tiny fresh TikTok does not become viral from age alone', () => {
    const r = tiktok(500, 1 / 6);
    expect(r.state).toBe('insufficient_evidence');
    expect(r.score).toBeNull();
    expect(r.viralNow?.evidence).toBe(false);
    expect(r.reasonCodes).toContain('REACH_BELOW_MINIMUM');
  });

  it('4. a moderately successful but slow TikTok scores below a genuinely fast breakout', () => {
    const slow = tiktok(400_000, 40);
    const fast = tiktok(1_000_000, 10);
    expect(slow.state).toBe('provisional');
    expect(value(slow)).toBeLessThan(value(fast));
  });

  it('5. no publish time and one snapshot stays insufficient evidence', () => {
    const r = score({ platform: 'tiktok', ageHours: null, views: [[0, 2_000_000]] });
    expect(r.state).toBe('insufficient_evidence');
    expect(r.components.pace.available).toBe(false);
  });

  it('6. a second spaced snapshot moves TikTok toward measured velocity like other platforms', () => {
    const base: Spec = { platform: 'tiktok', ageHours: 6, views: [[2, 400_000]] };
    const firstOnly = scoreCandidate({ ...input(base), asOf: hoursAgo(2) });
    const strong = score({
      ...base,
      views: [
        [2, 400_000],
        [0, 900_000],
      ],
    });
    const weak = score({
      ...base,
      views: [
        [2, 400_000],
        [0, 410_000],
      ],
    });
    expect(firstOnly.state).toBe('provisional');
    expect(strong.state).toBe('scored');
    const share = strong.components.momentum.available
      ? strong.components.momentum.details['observedShare']
      : null;
    expect(share).toBeCloseTo(0.5, 1);
    expect(value(strong)).toBeGreaterThanOrEqual(value(firstOnly));
    expect(value(weak)).toBeLessThan(value(firstOnly));
    // Reach stays in the measured core (same mechanics as every platform).
    expect(
      strong.components.momentum.available && strong.components.momentum.details['reach'],
    ).toBe(strong.components.reach.available ? strong.components.reach.value : null);
  });
});
