/**
 * Score lifecycle: load evidence → scoreCandidate() (pure, @vd/scoring) → store.
 * Idempotent: a score row is written only when its evidence fingerprint differs
 * from the latest score of the same algorithm version (or when forced).
 */
import { and, desc, eq, gte, inArray, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { schema } from '@vd/db';
import {
  DEFAULT_SCORING_CONFIG,
  evidenceFingerprint,
  scoreCandidate,
  type PlatformPopulation,
  type ScoreResult,
  type ScoringConfig,
  type ScoringInput,
  type SightingInput,
  type SnapshotInput,
  type SourceEngagement,
} from '@vd/scoring';
import type { PipelineDeps } from './ingest.ts';
import { PipelineError } from './sources.ts';

const { videos, metricSnapshots, sightings, sources, scores } = schema;
const POPULATION_WINDOW_DAYS = 14;

/** adapter id → platform, for telling source-propagation sightings from native ones. */
function adapterPlatform(deps: PipelineDeps, adapterId: string): string | null {
  const known = deps.adapterPlatforms?.[adapterId];
  if (known) return known;
  return deps.registry.has(adapterId) ? deps.registry.get(adapterId).manifest.platform : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sourceEngagement(context: Record<string, unknown>): SourceEngagement | null {
  // Convention: discovery sources put their own item's engagement in `postEngagement`.
  const e = context['postEngagement'];
  if (typeof e !== 'object' || e === null) return null;
  const r = e as Record<string, unknown>;
  return {
    likes: num(r['likes']),
    reposts: num(r['reposts']),
    replies: num(r['replies']),
    quotes: num(r['quotes']),
  };
}

export async function loadScoringInput(
  deps: PipelineDeps,
  videoId: string,
  asOf: Date,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): Promise<{ input: ScoringInput; latestSnapshotId: string | null }> {
  const [video] = await deps.db.select().from(videos).where(eq(videos.id, videoId));
  if (!video) throw new PipelineError(`video ${videoId} not found`);

  const snapRows = await deps.db
    .select()
    .from(metricSnapshots)
    .where(and(eq(metricSnapshots.videoId, videoId), lte(metricSnapshots.capturedAt, asOf)))
    .orderBy(metricSnapshots.capturedAt);
  const snapshots: SnapshotInput[] = snapRows.map((s) => ({
    capturedAt: s.capturedAt,
    metrics: {
      views: s.views,
      likes: s.likes,
      comments: s.comments,
      shares: s.shares,
      upvotes: s.upvotes,
      upvoteRatio: s.upvoteRatio,
    },
  }));

  const sightingRows = await deps.db
    .select({ s: sightings, adapterId: sources.adapterId })
    .from(sightings)
    .innerJoin(sources, eq(sources.id, sightings.sourceId))
    .where(and(eq(sightings.videoId, videoId), lte(sightings.seenAt, asOf)));
  const sightingInputs: SightingInput[] = sightingRows.map(({ s, adapterId }) => ({
    sourceId: s.sourceId,
    sourcePlatform: adapterPlatform(deps, adapterId),
    observationKey: s.observationKey || s.id,
    runId: s.discoveryRunId,
    seenAt: s.seenAt,
    sourceEngagement: sourceEngagement(s.context),
  }));

  const growth = snapshots.some((s) => s.metrics.views != null) ? 'views' : 'likes';

  // Creator history: latest growth-metric value of each OTHER video by the creator.
  let creator: ScoringInput['creator'] = null;
  if (video.creatorId) {
    const others = await deps.db
      .selectDistinctOn([metricSnapshots.videoId], {
        videoId: metricSnapshots.videoId,
        views: metricSnapshots.views,
        likes: metricSnapshots.likes,
      })
      .from(metricSnapshots)
      .innerJoin(videos, eq(videos.id, metricSnapshots.videoId))
      .where(
        and(
          eq(videos.creatorId, video.creatorId),
          ne(videos.id, videoId),
          lte(metricSnapshots.capturedAt, asOf),
        ),
      )
      .orderBy(metricSnapshots.videoId, desc(metricSnapshots.capturedAt));
    creator = {
      otherVideoValues: others.flatMap((o) => {
        const v = growth === 'views' ? o.views : o.likes;
        return v === null ? [] : [v];
      }),
    };
  }

  const population = await loadPopulation(deps, video.platform, videoId, asOf, config.version);
  return {
    input: {
      platform: video.platform,
      publishedAt: video.publishedAt,
      firstDiscoveredAt: video.firstDiscoveredAt,
      snapshots,
      sightings: sightingInputs,
      creator,
      population,
      asOf,
    },
    latestSnapshotId: snapRows[snapRows.length - 1]?.id ?? null,
  };
}

/**
 * Rolling platform population: the latest score (same algorithm version) of every
 * OTHER video on the platform in the last 14 days, up to asOf.
 */
export async function loadPopulation(
  deps: PipelineDeps,
  platform: string,
  excludeVideoId: string,
  asOf: Date,
  version: string,
): Promise<PlatformPopulation> {
  const since = new Date(asOf.getTime() - POPULATION_WINDOW_DAYS * 86_400_000);
  const rows = await deps.db
    .selectDistinctOn([scores.videoId], { videoId: scores.videoId, components: scores.components })
    .from(scores)
    .innerJoin(videos, eq(videos.id, scores.videoId))
    .where(
      and(
        eq(videos.platform, platform),
        ne(scores.videoId, excludeVideoId),
        eq(scores.algorithmVersion, version),
        gte(scores.computedAt, since),
        lte(scores.computedAt, asOf),
      ),
    )
    .orderBy(scores.videoId, desc(scores.computedAt));
  const population: PlatformPopulation = { logVelocity: {}, engagementRate: {} };
  for (const { components } of rows) {
    const velocity = components['velocity'] as
      { available?: boolean; details?: Record<string, unknown> } | undefined;
    const metric = velocity?.details?.['metric'];
    const log = num(velocity?.details?.['logPerHour']);
    if (velocity?.available && (metric === 'views' || metric === 'likes') && log !== null) {
      (population.logVelocity[metric] ??= []).push(log);
    }
    const engagement = components['engagement'] as
      { available?: boolean; details?: { rates?: Record<string, { rate?: unknown }> } } | undefined;
    for (const m of ['likes', 'comments', 'shares'] as const) {
      const rate = num(engagement?.details?.rates?.[m]?.rate);
      if (engagement?.available && rate !== null) (population.engagementRate[m] ??= []).push(rate);
    }
  }
  return population;
}

export interface ScoreVideoResult {
  videoId: string;
  status: 'created' | 'unchanged';
  scoreId: string | null;
  result: ScoreResult;
}

export async function scoreVideo(
  deps: PipelineDeps,
  videoId: string,
  options: { config?: ScoringConfig; asOf?: Date; force?: boolean } = {},
): Promise<ScoreVideoResult> {
  const config = options.config ?? DEFAULT_SCORING_CONFIG;
  const asOf = options.asOf ?? (deps.now ?? (() => new Date()))();
  const { input, latestSnapshotId } = await loadScoringInput(deps, videoId, asOf, config);
  const result = scoreCandidate(input, config);
  const inputsHash = evidenceFingerprint(input, config);

  if (!options.force) {
    const [latest] = await deps.db
      .select({ id: scores.id, inputsHash: scores.inputsHash })
      .from(scores)
      .where(and(eq(scores.videoId, videoId), eq(scores.algorithmVersion, config.version)))
      .orderBy(desc(scores.computedAt))
      .limit(1);
    if (latest?.inputsHash === inputsHash)
      return { videoId, status: 'unchanged', scoreId: latest.id, result };
  }

  const [row] = await deps.db
    .insert(scores)
    .values({
      videoId,
      algorithmVersion: result.algorithmVersion,
      value: result.score,
      state: result.state,
      confidence: result.confidence,
      components: {
        ...result.components,
        _meta: { rawScore: result.rawScore, growthMetric: result.growthMetric },
      },
      missingMetrics: result.missingMetrics,
      reasonCodes: result.reasonCodes,
      inputsHash,
      basedOnSnapshotId: latestSnapshotId,
      computedAt: asOf,
    })
    .returning({ id: scores.id });
  return { videoId, status: 'created', scoreId: row?.id ?? null, result };
}

export type RescoreScope =
  | { kind: 'stale' } // no score yet, or new snapshots/sightings since the last score
  | { kind: 'unscored' }
  | { kind: 'recent'; hours: number }
  | { kind: 'videos'; videoIds: string[] };

export interface RescoreOptions {
  scope: RescoreScope;
  platform?: string;
  limit: number;
  force?: boolean;
  config?: ScoringConfig;
}

/** Videos eligible for (re)scoring under a scope. Never the whole table by default. */
export async function selectForScoring(
  deps: PipelineDeps,
  options: RescoreOptions,
): Promise<string[]> {
  const version = (options.config ?? DEFAULT_SCORING_CONFIG).version;
  const now = (deps.now ?? (() => new Date()))();
  const lastScore = sql`(select max(${scores.computedAt}) from ${scores} where ${scores.videoId} = ${videos.id} and ${scores.algorithmVersion} = ${version})`;
  const conditions: (SQL | undefined)[] = [
    options.platform ? eq(videos.platform, options.platform) : undefined,
  ];
  const { scope } = options;
  if (scope.kind === 'videos') conditions.push(inArray(videos.id, scope.videoIds));
  if (scope.kind === 'unscored') conditions.push(sql`${lastScore} is null`);
  if (scope.kind === 'recent')
    conditions.push(
      gte(videos.firstDiscoveredAt, new Date(now.getTime() - scope.hours * 3_600_000)),
    );
  if (scope.kind === 'stale') {
    conditions.push(
      or(
        sql`${lastScore} is null`,
        sql`exists (select 1 from ${metricSnapshots} where ${metricSnapshots.videoId} = ${videos.id} and ${metricSnapshots.capturedAt} > ${lastScore})`,
        sql`exists (select 1 from ${sightings} where ${sightings.videoId} = ${videos.id} and ${sightings.seenAt} > ${lastScore})`,
      ),
    );
  }
  const rows = await deps.db
    .select({ id: videos.id })
    .from(videos)
    .where(and(...conditions))
    .orderBy(desc(videos.firstDiscoveredAt), videos.id)
    .limit(options.limit);
  return rows.map((r) => r.id);
}

export interface RescoreSummary {
  algorithmVersion: string;
  considered: number;
  created: number;
  unchanged: number;
  byState: Record<string, number>;
  failures: { videoId: string; error: string }[];
  results: ScoreVideoResult[];
}

export async function rescore(
  deps: PipelineDeps,
  options: RescoreOptions,
): Promise<RescoreSummary> {
  const config = options.config ?? DEFAULT_SCORING_CONFIG;
  const ids = await selectForScoring(deps, options);
  const asOf = (deps.now ?? (() => new Date()))();
  const summary: RescoreSummary = {
    algorithmVersion: config.version,
    considered: ids.length,
    created: 0,
    unchanged: 0,
    byState: {},
    failures: [],
    results: [],
  };
  for (const id of ids) {
    try {
      const r = await scoreVideo(deps, id, {
        config,
        asOf,
        ...(options.force ? { force: true } : {}),
      });
      summary.results.push(r);
      if (r.status === 'created') summary.created += 1;
      else summary.unchanged += 1;
      summary.byState[r.result.state] = (summary.byState[r.result.state] ?? 0) + 1;
    } catch (err) {
      summary.failures.push({
        videoId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return summary;
}
