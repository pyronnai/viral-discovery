import { z } from 'zod';

/**
 * Engagement metrics we may observe. Not every platform provides every metric —
 * see MetricReading and the adapter manifest's `metricsProvided`.
 */
export const METRIC_KEYS = [
  'views',
  'likes',
  'comments',
  'shares',
  'upvotes',
  'upvoteRatio',
] as const;
export const MetricKeySchema = z.enum(METRIC_KEYS);
export type MetricKey = z.infer<typeof MetricKeySchema>;

/**
 * Why a metric has no value. Keeping the reason matters for scoring:
 * "the platform never reports shares" is different from "the creator hid likes".
 */
export const MetricUnavailableReasonSchema = z.enum([
  'not_provided_by_platform', // the platform/API has no such metric
  'hidden_by_owner', // the platform supports it but the owner hid it
  'not_requested', // adapter did not fetch it this time (e.g. to save quota)
  'unknown', // missing without an explanation
]);
export type MetricUnavailableReason = z.infer<typeof MetricUnavailableReasonSchema>;

export const MetricReadingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('value'), value: z.number().nonnegative() }),
  z.object({ kind: z.literal('unavailable'), reason: MetricUnavailableReasonSchema }),
]);
export type MetricReading = z.infer<typeof MetricReadingSchema>;

/** A full set of readings; every key is always present, so "missing" is always explicit. */
export const MetricReadingsSchema = z
  .object({
    views: MetricReadingSchema,
    likes: MetricReadingSchema,
    comments: MetricReadingSchema,
    shares: MetricReadingSchema,
    upvotes: MetricReadingSchema,
    upvoteRatio: MetricReadingSchema,
  })
  .superRefine((m, ctx) => {
    if (m.upvoteRatio.kind === 'value' && m.upvoteRatio.value > 1) {
      ctx.addIssue({ code: 'custom', path: ['upvoteRatio'], message: 'upvoteRatio must be 0..1' });
    }
    for (const key of ['views', 'likes', 'comments', 'shares', 'upvotes'] as const) {
      const r = m[key];
      if (r.kind === 'value' && !Number.isInteger(r.value)) {
        ctx.addIssue({ code: 'custom', path: [key], message: `${key} must be an integer count` });
      }
    }
  });
export type MetricReadings = z.infer<typeof MetricReadingsSchema>;

export const metricValue = (value: number): MetricReading => ({ kind: 'value', value });
export const metricUnavailable = (reason: MetricUnavailableReason): MetricReading => ({
  kind: 'unavailable',
  reason,
});

/** Builds a readings object where every metric is unavailable unless overridden. */
export function buildReadings(
  partial: Partial<MetricReadings>,
  defaultReason: MetricUnavailableReason = 'not_provided_by_platform',
): MetricReadings {
  const out = {} as Record<MetricKey, MetricReading>;
  for (const key of METRIC_KEYS) out[key] = partial[key] ?? metricUnavailable(defaultReason);
  return out;
}
