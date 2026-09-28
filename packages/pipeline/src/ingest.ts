import { eq } from 'drizzle-orm';
import {
  CAPABILITY_METHODS,
  QUERY_KIND_CAPABILITY,
  QuotaBudgetExhaustedError,
  isReference,
  safeNormalize,
  type AdapterContext,
  type AdapterRegistry,
  type DiscoveryRequest,
  type NormalizedVideo,
  type RawItem,
  type SourceAdapter,
} from '@vd/adapter-contract';
import type { Logger } from '@vd/config';
import type { DiscoveryRunStatus, DiscoveryRunTrigger, SourceQueryKind } from '@vd/core';
import { schema, type AnyDatabase } from '@vd/db';
import {
  insertSighting,
  insertSnapshot,
  recordApiUsage,
  upsertCreator,
  upsertVideo,
  type Executor,
} from './persist.ts';
import {
  PipelineError,
  ensureSource,
  loadQuotaBudget,
  usageDate,
  type SourceRow,
} from './sources.ts';

export interface PipelineDeps {
  db: AnyDatabase;
  registry: AdapterRegistry;
  logger: Logger;
  now?: () => Date;
  signal?: AbortSignal;
  /**
   * adapter id → platform for every known adapter, including unconfigured ones
   * (whose sources may still have sightings). Falls back to the registry.
   */
  adapterPlatforms?: Record<string, string>;
}

/** Platform-agnostic filters applied to normalized videos, never to raw payloads. */
export interface DiscoveryFilters {
  /** Drop videos longer than this. Videos with unknown duration are kept (and counted). */
  maxDurationMs?: number;
}

export interface RunStats {
  ingested: number;
  videosUpdated: number;
  sightingsCreated: number;
  snapshotsCreated: number;
  filtered: number;
  invalid: number;
  keptWithUnknownDuration: number;
  filteredSamples: { externalId: string; platformVideoId: string; reason: string }[];
  invalidSamples: { externalId: string; errors: string[] }[];
  quotaUsed: Record<string, number>;
}

export interface RunSummary {
  runId: string;
  source: string;
  adapterId: string;
  status: DiscoveryRunStatus;
  itemsFound: number;
  itemsNew: number;
  error: string | null;
  stats: RunStats;
  /** Video ids touched by this run, in order of first appearance. */
  videoIds: string[];
}

const SAMPLE_LIMIT = 25;

export function adapterContext(
  deps: PipelineDeps,
  adapter: SourceAdapter,
  quota: AdapterContext['quota'],
) {
  return {
    logger: deps.logger.child({ adapter: adapter.manifest.id }),
    signal: deps.signal ?? new AbortController().signal,
    quota,
    now: deps.now ?? (() => new Date()),
  } satisfies AdapterContext;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Writes one normalized item: creator → video → sighting → first snapshot. */
async function ingestOne(
  db: Executor,
  args: {
    adapter: SourceAdapter;
    source: SourceRow;
    runId: string | null;
    raw: RawItem;
    video: NormalizedVideo;
    writeSnapshot: boolean;
    writeSighting: boolean;
  },
) {
  const { adapter, source, runId, raw, video } = args;
  const authoritative = !isReference(adapter, video);
  return db.transaction(async (tx) => {
    const creatorId = video.creator ? await upsertCreator(tx, video.creator, authoritative) : null;
    const row = await upsertVideo(tx, video, { authoritative, creatorId, raw });
    const sighting = args.writeSighting
      ? await insertSighting(tx, { videoId: row.id, sourceId: source.id, runId, raw })
      : false;
    // Only the canonical platform reports a video's metrics.
    const snapshot =
      args.writeSnapshot && authoritative && video.metrics
        ? await insertSnapshot(tx, {
            videoId: row.id,
            sourceId: source.id,
            capturedAt: video.observedAt,
            readings: video.metrics,
          })
        : false;
    return { videoId: row.id, inserted: row.inserted, sighting, snapshot };
  });
}

/**
 * Runs raw items from one adapter through normalize → identity → storage and
 * records the run. Never branches on which adapter or platform is involved.
 */
async function runItems(
  deps: PipelineDeps,
  args: {
    adapter: SourceAdapter;
    source: SourceRow;
    trigger: DiscoveryRunTrigger;
    sourceQueryId: string | null;
    request: Record<string, unknown>;
    filters: DiscoveryFilters;
    items: (ctx: AdapterContext) => AsyncIterable<RawItem>;
  },
): Promise<RunSummary> {
  const { db, logger } = deps;
  const { adapter, source, filters } = args;
  const now = deps.now ?? (() => new Date());

  const [run] = await db
    .insert(schema.discoveryRuns)
    .values({
      sourceId: source.id,
      sourceQueryId: args.sourceQueryId,
      trigger: args.trigger,
      status: 'running',
      startedAt: now(),
      // The pipeline clock, not the DB clock: cadence scheduling compares against it.
      createdAt: now(),
      request: args.request,
    })
    .returning({ id: schema.discoveryRuns.id });
  if (!run) throw new PipelineError('could not create discovery run');

  const quota = await loadQuotaBudget(db, source, now(), adapter.manifest);
  const ctx = adapterContext(deps, adapter, quota);
  const stats: RunStats = {
    ingested: 0,
    videosUpdated: 0,
    sightingsCreated: 0,
    snapshotsCreated: 0,
    filtered: 0,
    invalid: 0,
    keptWithUnknownDuration: 0,
    filteredSamples: [],
    invalidSamples: [],
    quotaUsed: {},
  };
  const videoIds: string[] = [];
  const snapshotted = new Set<string>();
  let itemsFound = 0;
  let itemsNew = 0;
  let error: string | null = null;
  let status: DiscoveryRunStatus = 'succeeded';

  try {
    for await (const raw of args.items(ctx)) {
      itemsFound += 1;
      const normalized = safeNormalize(adapter, raw);
      if (!normalized.ok) {
        // Quarantined: counted and sampled on the run, never silently dropped.
        stats.invalid += 1;
        if (stats.invalidSamples.length < SAMPLE_LIMIT) {
          stats.invalidSamples.push({ externalId: raw.externalId, errors: normalized.errors });
        }
        logger.warn({ externalId: raw.externalId, errors: normalized.errors }, 'item quarantined');
        continue;
      }
      const video = normalized.value;
      if (filters.maxDurationMs !== undefined) {
        if (video.durationMs === null) {
          stats.keptWithUnknownDuration += 1;
        } else if (video.durationMs > filters.maxDurationMs) {
          stats.filtered += 1;
          if (stats.filteredSamples.length < SAMPLE_LIMIT) {
            stats.filteredSamples.push({
              externalId: raw.externalId,
              platformVideoId: video.platformVideoId,
              reason: `duration ${video.durationMs}ms > max ${filters.maxDurationMs}ms`,
            });
          }
          continue;
        }
      }
      const key = `${video.platform}:${video.platformVideoId}`;
      const result = await ingestOne(db, {
        adapter,
        source,
        runId: run.id,
        raw,
        video,
        writeSighting: true,
        // One snapshot per video per run, even if it appears in several charts.
        writeSnapshot: !snapshotted.has(key),
      });
      snapshotted.add(key);
      stats.ingested += 1;
      if (result.inserted) itemsNew += 1;
      else stats.videosUpdated += 1;
      if (result.sighting) stats.sightingsCreated += 1;
      if (result.snapshot) stats.snapshotsCreated += 1;
      if (!videoIds.includes(result.videoId)) videoIds.push(result.videoId);
    }
  } catch (err) {
    error = errorMessage(err);
    status = itemsFound > 0 || err instanceof QuotaBudgetExhaustedError ? 'partial' : 'failed';
    logger.error({ err, runId: run.id }, 'discovery run did not complete');
  }

  stats.quotaUsed = { ...quota.usage() };
  await recordApiUsage(db, source.id, usageDate(now()), stats.quotaUsed);
  await db
    .update(schema.discoveryRuns)
    .set({ status, finishedAt: now(), itemsFound, itemsNew, error, stats: { ...stats } })
    .where(eq(schema.discoveryRuns.id, run.id));

  return {
    runId: run.id,
    source: source.name,
    adapterId: adapter.manifest.id,
    status,
    itemsFound,
    itemsNew,
    error,
    stats,
    videoIds,
  };
}

export interface DiscoverOptions {
  adapterId: string;
  kind: SourceQueryKind;
  params: Record<string, unknown>;
  region?: string | null;
  limit: number;
  filters?: DiscoveryFilters;
  /** Source row name; defaults to the adapter id. */
  sourceName?: string;
  sourceQueryId?: string | null;
  trigger?: DiscoveryRunTrigger;
}

export function getAdapter(registry: AdapterRegistry, adapterId: string): SourceAdapter {
  if (!registry.has(adapterId)) {
    const known = registry.list().map((a) => a.manifest.id);
    throw new PipelineError(
      `adapter "${adapterId}" is not available (registered: ${known.join(', ') || 'none'})`,
    );
  }
  return registry.get(adapterId);
}

/** adapter.discover* → normalize → identity → creator/video upsert → sighting → snapshot → run stats. */
export async function runDiscovery(
  deps: PipelineDeps,
  options: DiscoverOptions,
): Promise<RunSummary> {
  const adapter = getAdapter(deps.registry, options.adapterId);
  const capability = QUERY_KIND_CAPABILITY[options.kind];
  if (!deps.registry.supports(adapter.manifest.id, capability)) {
    const kinds = Object.entries(QUERY_KIND_CAPABILITY)
      .filter(([, c]) => adapter.manifest.capabilities.includes(c))
      .map(([k]) => k);
    throw new PipelineError(
      `adapter "${adapter.manifest.id}" does not support "${options.kind}" discovery (supports: ${kinds.join(', ') || 'none'})`,
    );
  }
  const method = CAPABILITY_METHODS[capability];
  if (typeof adapter[method] !== 'function') {
    throw new PipelineError(`adapter "${adapter.manifest.id}" lacks ${method}()`);
  }
  type Discover = (req: DiscoveryRequest, ctx: AdapterContext) => AsyncIterable<RawItem>;
  const discover = (req: DiscoveryRequest, ctx: AdapterContext) =>
    (adapter[method] as Discover)(req, ctx);

  const source = await ensureSource(deps.db, adapter.manifest, options.sourceName);
  const request: DiscoveryRequest = {
    kind: options.kind,
    params: options.params,
    region: options.region ?? null,
    limit: options.limit,
  };
  return runItems(deps, {
    adapter,
    source,
    trigger: options.trigger ?? 'manual',
    sourceQueryId: options.sourceQueryId ?? null,
    request: { adapterId: adapter.manifest.id, ...request, filters: options.filters ?? {} },
    filters: options.filters ?? {},
    items: (ctx) => discover(request, ctx),
  });
}

/** Loads a stored SourceQuery (and its Source) and runs it. */
export async function runSourceQuery(
  deps: PipelineDeps,
  sourceQueryId: string,
  options: { limit: number; filters?: DiscoveryFilters; trigger?: DiscoveryRunTrigger },
): Promise<RunSummary> {
  const [row] = await deps.db
    .select({ query: schema.sourceQueries, source: schema.sources })
    .from(schema.sourceQueries)
    .innerJoin(schema.sources, eq(schema.sources.id, schema.sourceQueries.sourceId))
    .where(eq(schema.sourceQueries.id, sourceQueryId));
  if (!row) throw new PipelineError(`source query ${sourceQueryId} not found`);
  return runDiscovery(deps, {
    adapterId: row.source.adapterId,
    sourceName: row.source.name,
    sourceQueryId,
    kind: row.query.kind,
    params: row.query.params,
    region: row.query.region,
    limit: options.limit,
    ...(options.filters ? { filters: options.filters } : {}),
    trigger: options.trigger ?? 'manual',
  });
}

export { runItems, ingestOne };
