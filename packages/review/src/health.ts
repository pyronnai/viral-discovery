/**
 * Discovery health: is the system actually finding fresh videos? A small,
 * read-only operational summary per adapter and source — not an observability
 * product. Built only from stored runs, usage, and adapter wiring status.
 */
import { sql } from 'drizzle-orm';
import type { AnyDatabase } from '@vd/db';
import { rows } from './feed.ts';

/** What the dashboard knows about each adapter from wiring (no secrets). */
export interface AdapterInfo {
  id: string;
  displayName: string;
  platform: string;
  configured: boolean;
  /** Names (never values) of missing variables. */
  missingEnv: string[];
}

export interface PlannedAdapterInfo {
  id: string;
  reason: string;
}

export type SourceState =
  'healthy' | 'stale' | 'failing' | 'never_run' | 'disabled' | 'unconfigured';

export interface SourceHealth {
  sourceId: string;
  name: string;
  enabled: boolean;
  enabledQueries: number;
  state: SourceState;
  lastSuccessAt: Date | null;
  lastRunAt: Date | null;
  lastRunStatus: string | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  runs24h: number;
  found24h: number;
  new24h: number;
  quarantined24h: number;
  /** Today's usage per quota bucket, with the configured budget when one is set. */
  quota: { bucket: string; used: number; budget: number | null }[];
}

export interface AdapterHealth extends AdapterInfo {
  sources: SourceHealth[];
}

export interface DiscoveryHealth {
  adapters: AdapterHealth[];
  planned: PlannedAdapterInfo[];
  /** Sources whose adapter is not known to this build. */
  orphanSources: SourceHealth[];
  pipeline: {
    videosDiscovered24h: number;
    lastScoredAt: Date | null;
    lastDuplicateScanAt: Date | null;
    lastClassifiedAt: Date | null;
    unprocessedForDuplicates: number;
  };
}

/** A source counts as stale when its last successful run is older than this. */
export const STALE_AFTER_HOURS = 24;

interface SourceRow {
  sourceId: string;
  name: string;
  adapterId: string;
  enabled: boolean;
  budgets: Record<string, number>;
  enabledQueries: number;
  lastSuccessAt: Date | null;
  lastRunAt: Date | null;
  lastRunStatus: string | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  runs24h: number;
  found24h: number;
  new24h: number;
  quarantined24h: number;
  usage: Record<string, number> | null;
}

export async function getDiscoveryHealth(
  db: AnyDatabase,
  input: { adapters: AdapterInfo[]; planned?: PlannedAdapterInfo[]; now?: Date },
): Promise<DiscoveryHealth> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - 24 * 3_600_000);
  const today = now.toISOString().slice(0, 10);
  const sources = await rows<SourceRow>(
    db,
    sql`select s.id as "sourceId", s.name, s.adapter_id as "adapterId", s.enabled,
        s.daily_quota_budgets as budgets,
        (select count(*)::int from source_queries q where q.source_id = s.id and q.enabled) as "enabledQueries",
        (select max(coalesce(r.finished_at, r.created_at)) from discovery_runs r
          where r.source_id = s.id and r.status in ('succeeded', 'partial')) as "lastSuccessAt",
        last.at as "lastRunAt", last.status as "lastRunStatus",
        err.error as "lastError", err.at as "lastErrorAt",
        (select count(*)::int from discovery_runs r where r.source_id = s.id and r.created_at >= ${since}) as "runs24h",
        (select coalesce(sum(r.items_found), 0)::int from discovery_runs r
          where r.source_id = s.id and r.created_at >= ${since}) as "found24h",
        (select coalesce(sum(r.items_new), 0)::int from discovery_runs r
          where r.source_id = s.id and r.created_at >= ${since}) as "new24h",
        (select coalesce(sum((r.stats->>'invalid')::int), 0)::int from discovery_runs r
          where r.source_id = s.id and r.created_at >= ${since}) as "quarantined24h",
        (select jsonb_object_agg(u.quota_bucket, u.units_used) from api_usage u
          where u.source_id = s.id and u.usage_date = ${today}) as usage
      from sources s
      left join lateral (
        select r.status::text as status, coalesce(r.finished_at, r.created_at) as at from discovery_runs r
        where r.source_id = s.id order by r.created_at desc, r.id desc limit 1
      ) last on true
      left join lateral (
        select r.error, coalesce(r.finished_at, r.created_at) as at from discovery_runs r
        where r.source_id = s.id and r.error is not null order by r.created_at desc, r.id desc limit 1
      ) err on true
      order by s.name`,
  );
  const [pipeline] = await rows<DiscoveryHealth['pipeline']>(
    db,
    sql`select
      (select count(*)::int from videos where first_discovered_at >= ${since}) as "videosDiscovered24h",
      (select max(computed_at) from scores) as "lastScoredAt",
      (select max(duplicate_scanned_at) from videos) as "lastDuplicateScanAt",
      (select max(created_at) from classifications) as "lastClassifiedAt",
      (select count(*)::int from videos where duplicate_scanned_at is null) as "unprocessedForDuplicates"`,
  );

  const adapterById = new Map(input.adapters.map((a) => [a.id, a]));
  const toHealth = (s: SourceRow, configured: boolean): SourceHealth => {
    const failing = s.lastRunStatus === 'failed';
    const state: SourceState = !configured
      ? 'unconfigured'
      : !s.enabled
        ? 'disabled'
        : failing
          ? 'failing'
          : !s.lastSuccessAt
            ? 'never_run'
            : now.getTime() - new Date(s.lastSuccessAt).getTime() > STALE_AFTER_HOURS * 3_600_000
              ? 'stale'
              : 'healthy';
    const buckets = new Set([...Object.keys(s.budgets), ...Object.keys(s.usage ?? {})]);
    return {
      sourceId: s.sourceId,
      name: s.name,
      enabled: s.enabled,
      enabledQueries: s.enabledQueries,
      state,
      lastSuccessAt: s.lastSuccessAt,
      lastRunAt: s.lastRunAt,
      lastRunStatus: s.lastRunStatus,
      lastError: s.lastError,
      lastErrorAt: s.lastErrorAt,
      runs24h: s.runs24h,
      found24h: s.found24h,
      new24h: s.new24h,
      quarantined24h: s.quarantined24h,
      quota: [...buckets].sort().map((bucket) => ({
        bucket,
        used: s.usage?.[bucket] ?? 0,
        budget: s.budgets[bucket] ?? null,
      })),
    };
  };

  return {
    adapters: input.adapters.map((a) => ({
      ...a,
      sources: sources.filter((s) => s.adapterId === a.id).map((s) => toHealth(s, a.configured)),
    })),
    planned: input.planned ?? [],
    orphanSources: sources
      .filter((s) => !adapterById.has(s.adapterId))
      .map((s) => toHealth(s, false)),
    pipeline: pipeline ?? {
      videosDiscovered24h: 0,
      lastScoredAt: null,
      lastDuplicateScanAt: null,
      lastClassifiedAt: null,
      unprocessedForDuplicates: 0,
    },
  };
}
