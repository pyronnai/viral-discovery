/**
 * Cadence scheduling for stored SourceQueries. A query is due when it is enabled,
 * its source is enabled, it has a cadence, and its last run started at least
 * `cadence_minutes` ago (or it never ran). Quota is still bounded per source by
 * sources.daily_quota_budgets: a due query that would exceed it ends "partial".
 */
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { schema } from '@vd/db';
import {
  runSourceQuery,
  type DiscoveryFilters,
  type PipelineDeps,
  type RunSummary,
} from './ingest.ts';

export interface DueQuery {
  queryId: string;
  source: string;
  adapterId: string;
  kind: string;
  cadenceMinutes: number;
  lastRunAt: Date | null;
}

export async function dueQueries(
  deps: PipelineDeps,
): Promise<{ due: DueQuery[]; skipped: (DueQuery & { reason: string })[] }> {
  const now = (deps.now ?? (() => new Date()))();
  const rows = await deps.db
    .select({ query: schema.sourceQueries, source: schema.sources })
    .from(schema.sourceQueries)
    .innerJoin(schema.sources, eq(schema.sources.id, schema.sourceQueries.sourceId))
    .where(
      and(
        eq(schema.sourceQueries.enabled, true),
        eq(schema.sources.enabled, true),
        isNotNull(schema.sourceQueries.cadenceMinutes),
      ),
    )
    .orderBy(schema.sourceQueries.createdAt, schema.sourceQueries.id);
  const due: DueQuery[] = [];
  const skipped: (DueQuery & { reason: string })[] = [];
  for (const { query, source } of rows) {
    const [last] = await deps.db
      .select({ at: schema.discoveryRuns.createdAt })
      .from(schema.discoveryRuns)
      .where(eq(schema.discoveryRuns.sourceQueryId, query.id))
      .orderBy(desc(schema.discoveryRuns.createdAt))
      .limit(1);
    const entry: DueQuery = {
      queryId: query.id,
      source: source.name,
      adapterId: source.adapterId,
      kind: query.kind,
      cadenceMinutes: query.cadenceMinutes ?? 0,
      lastRunAt: last?.at ?? null,
    };
    if (last && last.at.getTime() + entry.cadenceMinutes * 60_000 > now.getTime()) continue;
    if (!deps.registry.has(source.adapterId)) {
      skipped.push({ ...entry, reason: `adapter "${source.adapterId}" is not configured` });
      continue;
    }
    due.push(entry);
  }
  return { due, skipped };
}

export async function runDueQueries(
  deps: PipelineDeps,
  options: { limit: number; maxQueries?: number; filters?: DiscoveryFilters },
): Promise<{ runs: RunSummary[]; skipped: (DueQuery & { reason: string })[] }> {
  const { due, skipped } = await dueQueries(deps);
  const runs: RunSummary[] = [];
  for (const q of due.slice(0, options.maxQueries ?? due.length)) {
    runs.push(
      await runSourceQuery(deps, q.queryId, {
        limit: options.limit,
        trigger: 'schedule',
        ...(options.filters ? { filters: options.filters } : {}),
      }),
    );
  }
  return { runs, skipped };
}
