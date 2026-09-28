import { eq } from 'drizzle-orm';
import {
  createInMemoryQuotaBudget,
  type AdapterManifest,
  type QuotaBudget,
} from '@vd/adapter-contract';
import { schema } from '@vd/db';
import { usedToday, type Executor } from './persist.ts';

export type SourceRow = typeof schema.sources.$inferSelect;

export class PipelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PipelineError';
  }
}

/**
 * Returns the Source row for an adapter, creating it on first use. Its daily
 * quota budgets start from the manifest's verified defaults and are then
 * editable in the database — never hardcoded in the pipeline.
 */
export async function ensureSource(
  db: Executor,
  manifest: AdapterManifest,
  name: string = manifest.id,
): Promise<SourceRow> {
  const budgets = Object.fromEntries(
    manifest.quotaBuckets
      .filter((b) => b.defaultDailyBudget !== null)
      .map((b) => [b.name, b.defaultDailyBudget as number]),
  );
  await db
    .insert(schema.sources)
    .values({ name, adapterId: manifest.id, enabled: true, dailyQuotaBudgets: budgets })
    .onConflictDoNothing({ target: schema.sources.name });
  const [source] = await db.select().from(schema.sources).where(eq(schema.sources.name, name));
  if (!source) throw new PipelineError(`source "${name}" could not be created`);
  if (source.adapterId !== manifest.id) {
    throw new PipelineError(
      `source "${name}" is configured for adapter "${source.adapterId}", not "${manifest.id}"`,
    );
  }
  return source;
}

/** UTC calendar date used for api_usage accounting. */
export function usageDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * A run's budget: per bucket, the source's configured daily budget — or, for a
 * bucket the source row does not configure yet (e.g. a bucket added in a later
 * adapter version), the manifest's verified default — minus today's usage.
 * Buckets with neither are locally unlimited (the platform still enforces its own).
 */
export async function loadQuotaBudget(
  db: Executor,
  source: SourceRow,
  now: Date,
  manifest?: AdapterManifest,
): Promise<QuotaBudget> {
  const used = await usedToday(db, source.id, usageDate(now));
  const limits: Record<string, number> = {};
  for (const bucket of manifest?.quotaBuckets ?? []) {
    if (bucket.defaultDailyBudget !== null) limits[bucket.name] = bucket.defaultDailyBudget;
  }
  Object.assign(limits, source.dailyQuotaBudgets);
  const remaining = Object.fromEntries(
    Object.entries(limits).map(([bucket, limit]) => [
      bucket,
      Math.max(0, limit - (used[bucket] ?? 0)),
    ]),
  );
  return createInMemoryQuotaBudget(remaining);
}
