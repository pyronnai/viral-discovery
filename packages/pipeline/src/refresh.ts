import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { checkRefreshResults, type SourceAdapter } from '@vd/adapter-contract';
import { schema } from '@vd/db';
import { adapterContext, type PipelineDeps } from './ingest.ts';
import { insertSnapshot, recordApiUsage } from './persist.ts';
import { PipelineError, ensureSource, loadQuotaBudget, usageDate } from './sources.ts';

export interface RefreshOptions {
  platform: string;
  /** Maximum videos to refresh; least recently refreshed first. */
  limit: number;
  videoIds?: string[];
}

export interface RefreshSummary {
  adapterId: string;
  requested: number;
  snapshotsCreated: number;
  unavailable: number;
  invalid: { platformVideoId: string | null; errors: string[] }[];
  error: string | null;
  quotaUsed: Record<string, number>;
}

export function refreshAdapter(deps: PipelineDeps, platform: string): SourceAdapter {
  const adapter = deps.registry
    .list()
    .find(
      (a) =>
        a.manifest.platform === platform && a.manifest.capabilities.includes('metrics.refresh'),
    );
  if (!adapter) {
    throw new PipelineError(`no configured adapter can refresh metrics for "${platform}" videos`);
  }
  return adapter;
}

/**
 * Re-reads engagement for stored videos of one platform — including videos first
 * seen through other sources — and appends metric snapshots. Scoring (velocity
 * between snapshots) is a later phase; this only collects the evidence.
 */
export async function refreshMetrics(
  deps: PipelineDeps,
  options: RefreshOptions,
): Promise<RefreshSummary> {
  const adapter = refreshAdapter(deps, options.platform);
  const now = deps.now ?? (() => new Date());
  const source = await ensureSource(deps.db, adapter.manifest);

  const conditions = [eq(schema.videos.platform, options.platform)];
  if (options.videoIds) conditions.push(inArray(schema.videos.id, options.videoIds));
  const rows = await deps.db
    .select({
      id: schema.videos.id,
      platformVideoId: schema.videos.platformVideoId,
      canonicalUrl: schema.videos.canonicalUrl,
    })
    .from(schema.videos)
    .where(and(...conditions))
    .orderBy(
      sql`${schema.videos.lastRefreshedAt} ASC NULLS FIRST`,
      asc(schema.videos.firstDiscoveredAt),
    )
    .limit(options.limit);

  const summary: RefreshSummary = {
    adapterId: adapter.manifest.id,
    requested: rows.length,
    snapshotsCreated: 0,
    unavailable: 0,
    invalid: [],
    error: null,
    quotaUsed: {},
  };
  if (rows.length === 0 || !adapter.refreshMetrics) return summary;

  const quota = await loadQuotaBudget(deps.db, source, now(), adapter.manifest);
  try {
    const results = await adapter.refreshMetrics(
      rows.map((r) => ({ platformVideoId: r.platformVideoId, canonicalUrl: r.canonicalUrl })),
      adapterContext(deps, adapter, quota),
    );
    const byPlatformId = new Map(rows.map((r) => [r.platformVideoId, r.id]));
    for (const check of checkRefreshResults(adapter, results)) {
      if (!check.ok) {
        summary.invalid.push({ platformVideoId: check.platformVideoId, errors: check.errors });
        continue;
      }
      const result = check.value;
      const videoId = byPlatformId.get(result.platformVideoId);
      if (!videoId) {
        summary.invalid.push({
          platformVideoId: result.platformVideoId,
          errors: ['not requested'],
        });
        continue;
      }
      await deps.db.transaction(async (tx) => {
        if (result.metrics) {
          const created = await insertSnapshot(tx, {
            videoId,
            sourceId: source.id,
            capturedAt: result.observedAt,
            readings: result.metrics,
          });
          if (created) summary.snapshotsCreated += 1;
        } else {
          summary.unavailable += 1;
        }
        await tx
          .update(schema.videos)
          .set({
            availability: result.availability,
            ...(result.metrics ? { lastRefreshedAt: result.observedAt } : {}),
            // Labelers often act after first discovery; a reported set replaces the stored one.
            ...(result.moderationLabels ? { sourceModerationLabels: result.moderationLabels } : {}),
            updatedAt: sql`now()`,
          })
          .where(eq(schema.videos.id, videoId));
      });
    }
  } catch (err) {
    summary.error = err instanceof Error ? err.message : String(err);
    deps.logger.error({ err, adapter: adapter.manifest.id }, 'metric refresh failed');
  } finally {
    summary.quotaUsed = { ...quota.usage() };
    await recordApiUsage(deps.db, source.id, usageDate(now()), summary.quotaUsed, quota.requests());
  }
  return summary;
}
