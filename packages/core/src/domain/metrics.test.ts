import { describe, expect, it } from 'vitest';
import { MetricReadingsSchema, buildReadings, metricUnavailable, metricValue } from './metrics.ts';

describe('metric readings', () => {
  it('makes every metric explicit, defaulting to unavailable', () => {
    const r = buildReadings({ views: metricValue(1000) });
    expect(r.views).toEqual({ kind: 'value', value: 1000 });
    expect(r.shares).toEqual({ kind: 'unavailable', reason: 'not_provided_by_platform' });
    expect(MetricReadingsSchema.parse(r)).toEqual(r);
  });

  it('distinguishes hidden metrics from unsupported ones', () => {
    const r = buildReadings({ likes: metricUnavailable('hidden_by_owner') });
    expect(r.likes).toEqual({ kind: 'unavailable', reason: 'hidden_by_owner' });
  });

  it('rejects impossible values', () => {
    expect(() =>
      MetricReadingsSchema.parse(buildReadings({ upvoteRatio: metricValue(1.5) })),
    ).toThrow();
    expect(() => MetricReadingsSchema.parse(buildReadings({ views: metricValue(1.5) }))).toThrow();
    expect(() => MetricReadingsSchema.parse(buildReadings({ views: metricValue(-1) }))).toThrow();
  });
});
