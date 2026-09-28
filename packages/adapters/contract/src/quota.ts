/**
 * Quota accounting seen by adapters. Platforms may meter different methods in
 * separate buckets, so consumption is always per named bucket.
 */
export interface QuotaBudget {
  /** Returns true and records usage if `units` fit in the bucket; false otherwise. */
  tryConsume(bucket: string, units: number): boolean;
  /** Remaining units, or null if the bucket has no configured limit. */
  remaining(bucket: string): number | null;
  /** Units used so far, per bucket. */
  usage(): Readonly<Record<string, number>>;
}

/**
 * In-memory budget for a single run. Buckets without a configured limit are
 * unlimited locally (the platform still enforces its own limit).
 */
export function createInMemoryQuotaBudget(limits: Readonly<Record<string, number>>): QuotaBudget {
  const used: Record<string, number> = {};
  return {
    tryConsume(bucket, units) {
      if (!Number.isFinite(units) || units < 0) throw new RangeError('units must be >= 0');
      const limit = limits[bucket];
      const current = used[bucket] ?? 0;
      if (limit !== undefined && current + units > limit) return false;
      used[bucket] = current + units;
      return true;
    },
    remaining(bucket) {
      const limit = limits[bucket];
      return limit === undefined ? null : Math.max(0, limit - (used[bucket] ?? 0));
    },
    usage() {
      return { ...used };
    },
  };
}

/** Thrown when a run's local budget for a bucket is exhausted; the run ends as "partial". */
export class QuotaBudgetExhaustedError extends Error {
  readonly bucket: string;
  constructor(bucket: string) {
    super(`local quota budget for bucket "${bucket}" is exhausted`);
    this.name = 'QuotaBudgetExhaustedError';
    this.bucket = bucket;
  }
}

/** Records usage before a metered call, or throws QuotaBudgetExhaustedError. */
export function consumeQuota(quota: QuotaBudget, bucket: string, units = 1): void {
  if (!quota.tryConsume(bucket, units)) throw new QuotaBudgetExhaustedError(bucket);
}
