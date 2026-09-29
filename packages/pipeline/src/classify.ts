/**
 * Content classification lifecycle (per cluster, using its representative video).
 *
 * - Inputs come only from stored data: title, caption, duration, creator, platform,
 *   thumbnail URL (fetched by the provider, never downloaded by us), and short
 *   discovery-context descriptors. No video download, no frame extraction.
 * - Idempotent: a cluster is classified once per (taxonomy version, prompt version,
 *   input fingerprint). A score change never triggers reclassification.
 * - Invalid model output is quarantined in classification_failures, never stored
 *   as a classification.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  ClassifierError,
  PROMPT_VERSION,
  TAXONOMY_VERSION,
  inputFingerprint,
  type ClassificationInput,
  type ContentClassifier,
} from '@vd/classification';
import { schema } from '@vd/db';
import { DEFAULT_SCORING_CONFIG } from '@vd/scoring';
import type { PipelineDeps } from './ingest.ts';
import { PipelineError } from './sources.ts';

const {
  clusters,
  videos,
  creators,
  sightings,
  sources,
  classifications,
  classificationFailures,
  scores,
  reviewEvents,
} = schema;

export interface ClassificationPolicy {
  /** Scored/provisional candidates at or above this virality score are eligible. */
  minScore: number;
  /** Review statuses that make a cluster eligible regardless of score. */
  reviewStatuses: readonly ('saved' | 'approved')[];
  /** Stop retrying an unchanged input after this many failures. */
  maxFailuresPerInput: number;
}

export const DEFAULT_CLASSIFICATION_POLICY: ClassificationPolicy = {
  minScore: 60,
  reviewStatuses: ['saved', 'approved'],
  maxFailuresPerInput: 3,
};

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Short, generic descriptors of how a video was found (keys, not platform names). */
export function describeContext(sourceName: string, context: Record<string, unknown>): string {
  const search = context['search'];
  const q =
    (typeof search === 'object' && search !== null
      ? str((search as Record<string, unknown>)['q'])
      : null) ?? str(context['query']);
  if (q) return `${sourceName}: search "${q.slice(0, 80)}"`;
  const chart = str(context['chart']);
  if (chart) return `${sourceName}: ${chart} chart ${str(context['regionCode']) ?? ''}`.trim();
  if (context['channelFeed']) return `${sourceName}: seed channel uploads`;
  if (str(context['gameId'])) return `${sourceName}: top clips for a game`;
  if (str(context['broadcasterId'])) return `${sourceName}: channel clips`;
  if (str(context['submittedUrl'])) return `${sourceName}: submitted by a reviewer`;
  return sourceName;
}

export async function buildClassificationInput(
  deps: PipelineDeps,
  clusterId: string,
): Promise<{ input: ClassificationInput; videoId: string }> {
  const [cluster] = await deps.db.select().from(clusters).where(eq(clusters.id, clusterId));
  if (!cluster) throw new PipelineError(`cluster ${clusterId} not found`);
  const [video] = cluster.representativeVideoId
    ? await deps.db.select().from(videos).where(eq(videos.id, cluster.representativeVideoId))
    : await deps.db
        .select()
        .from(videos)
        .where(eq(videos.clusterId, clusterId))
        .orderBy(videos.firstDiscoveredAt)
        .limit(1);
  if (!video) throw new PipelineError(`cluster ${clusterId} has no videos`);

  const [creator] = video.creatorId
    ? await deps.db.select().from(creators).where(eq(creators.id, video.creatorId))
    : [];
  const displayName = creator?.displayName ?? video.creatorDisplayName;
  const handle = creator?.handle ?? video.creatorHandle;

  const contexts = await deps.db
    .select({ context: sightings.context, sourceName: sources.name })
    .from(sightings)
    .innerJoin(sources, eq(sources.id, sightings.sourceId))
    .innerJoin(videos, eq(videos.id, sightings.videoId))
    .where(eq(videos.clusterId, clusterId));
  const discoveryContext = [
    ...new Set(contexts.map((c) => describeContext(c.sourceName, c.context))),
  ]
    .sort()
    .slice(0, 10);

  return {
    videoId: video.id,
    input: {
      platform: video.platform,
      canonicalUrl: video.canonicalUrl,
      title: video.title,
      caption: video.caption,
      durationMs: video.durationMs,
      publishedAt: video.publishedAt?.toISOString() ?? null,
      creator:
        displayName || handle ? { displayName: displayName ?? null, handle: handle ?? null } : null,
      thumbnailUrl: video.thumbnailUrl,
      discoveryContext,
    },
  };
}

export type ClassifyStatus = 'classified' | 'unchanged' | 'failed' | 'skipped';

export interface ClassifyClusterResult {
  clusterId: string;
  status: ClassifyStatus;
  classificationId?: string;
  error?: { kind: string; message: string; retryable: boolean; details: string[] };
  reason?: string;
}

export async function classifyCluster(
  deps: PipelineDeps,
  clusterId: string,
  options: { classifier: ContentClassifier; force?: boolean; policy?: ClassificationPolicy },
): Promise<ClassifyClusterResult> {
  const policy = options.policy ?? DEFAULT_CLASSIFICATION_POLICY;
  const { input, videoId } = await buildClassificationInput(deps, clusterId);
  const inputHash = inputFingerprint(input);
  const versionMatch = and(
    eq(classifications.clusterId, clusterId),
    eq(classifications.taxonomyVersion, TAXONOMY_VERSION),
    eq(classifications.promptVersion, PROMPT_VERSION),
    eq(classifications.inputHash, inputHash),
  );

  if (!options.force) {
    const [existing] = await deps.db
      .select({ id: classifications.id })
      .from(classifications)
      .where(versionMatch)
      .limit(1);
    if (existing) return { clusterId, status: 'unchanged', classificationId: existing.id };
    const [{ failures } = { failures: 0 }] = await deps.db
      .select({ failures: sql<number>`count(*)::int` })
      .from(classificationFailures)
      .where(
        and(
          eq(classificationFailures.clusterId, clusterId),
          eq(classificationFailures.taxonomyVersion, TAXONOMY_VERSION),
          eq(classificationFailures.promptVersion, PROMPT_VERSION),
          eq(classificationFailures.inputHash, inputHash),
        ),
      );
    if (failures >= policy.maxFailuresPerInput) {
      return {
        clusterId,
        status: 'skipped',
        reason: `${failures} failed attempts for unchanged input (use --force)`,
      };
    }
  }

  const now = (deps.now ?? (() => new Date()))();
  try {
    const out = await options.classifier.classify(
      input,
      deps.signal ? { signal: deps.signal } : {},
    );
    const [row] = await deps.db
      .insert(classifications)
      .values({
        clusterId,
        videoId,
        taxonomyVersion: TAXONOMY_VERSION,
        promptVersion: PROMPT_VERSION,
        provider: out.provider,
        model: out.model,
        labels: out.result.labels,
        safetyFlags: out.result.safetyFlags,
        rationale: out.result.summary,
        analysis: out.result.analysis,
        inputsUsed: { ...out.inputsUsed },
        inputHash,
        createdAt: now,
      })
      .returning({ id: classifications.id });
    return { clusterId, status: 'classified', ...(row ? { classificationId: row.id } : {}) };
  } catch (err) {
    if (!(err instanceof ClassifierError)) throw err;
    await deps.db.insert(classificationFailures).values({
      clusterId,
      videoId,
      provider: options.classifier.provider,
      model: options.classifier.model,
      taxonomyVersion: TAXONOMY_VERSION,
      promptVersion: PROMPT_VERSION,
      inputHash,
      errorKind: err.kind,
      error: err.message,
      details: err.details.slice(0, 20),
      retryable: err.retryable,
      attemptedAt: now,
    });
    deps.logger.warn({ clusterId, kind: err.kind }, 'classification failed');
    return {
      clusterId,
      status: 'failed',
      error: {
        kind: err.kind,
        message: err.message,
        retryable: err.retryable,
        details: err.details,
      },
    };
  }
}

/**
 * Candidate clusters for the classification gate: the representative's latest
 * score (current algorithm) is scored/provisional and ≥ minScore, or the cluster's
 * current review status is one of policy.reviewStatuses. Highest score first.
 */
export async function selectClassificationCandidates(
  deps: PipelineDeps,
  policy: ClassificationPolicy,
  limit: number,
): Promise<string[]> {
  const version = DEFAULT_SCORING_CONFIG.version;
  // The LATEST score decides (then its state is checked), never an older one.
  const latestScore = sql`(select case when ${scores.state} in ('scored', 'provisional') then ${scores.value} end from ${scores} where ${scores.videoId} = ${clusters.representativeVideoId} and ${scores.algorithmVersion} = ${version} order by ${scores.computedAt} desc limit 1)`;
  // Clusters without a classification for the current versions come first, so the
  // limit is not used up by clusters that would only come back "unchanged".
  const classified = sql`exists (select 1 from ${classifications} where ${classifications.clusterId} = ${clusters.id} and ${classifications.taxonomyVersion} = ${TAXONOMY_VERSION} and ${classifications.promptVersion} = ${PROMPT_VERSION})`;
  const latestReview = sql`(select ${reviewEvents.status} from ${reviewEvents} where ${reviewEvents.clusterId} = ${clusters.id} order by ${reviewEvents.createdAt} desc limit 1)`;
  const statuses = policy.reviewStatuses.length ? policy.reviewStatuses : ['__none__'];
  const rows = await deps.db
    .select({ id: clusters.id, score: sql<number | null>`${latestScore}` })
    .from(clusters)
    .where(
      sql`(${latestScore} >= ${policy.minScore} or ${latestReview}::text in (${sql.join(
        statuses.map((s) => sql`${s}`),
        sql`, `,
      )}))`,
    )
    .orderBy(sql`${classified}`, sql`${latestScore} desc nulls last`, clusters.id)
    .limit(limit);
  return rows.map((r) => r.id);
}

export interface ClassifySummary {
  considered: number;
  classified: number;
  unchanged: number;
  failed: number;
  skipped: number;
  results: ClassifyClusterResult[];
}

export async function classifyClusters(
  deps: PipelineDeps,
  clusterIds: readonly string[],
  options: { classifier: ContentClassifier; force?: boolean; policy?: ClassificationPolicy },
): Promise<ClassifySummary> {
  const summary: ClassifySummary = {
    considered: clusterIds.length,
    classified: 0,
    unchanged: 0,
    failed: 0,
    skipped: 0,
    results: [],
  };
  for (const id of clusterIds) {
    const r = await classifyCluster(deps, id, options);
    summary.results.push(r);
    if (r.status === 'classified') summary.classified += 1;
    else if (r.status === 'unchanged') summary.unchanged += 1;
    else if (r.status === 'failed') summary.failed += 1;
    else summary.skipped += 1;
  }
  return summary;
}

/** Eligible = passes the gate and is not already classified for the current versions + input. */
export async function classifyEligible(
  deps: PipelineDeps,
  options: { classifier: ContentClassifier; policy?: ClassificationPolicy; limit: number },
): Promise<ClassifySummary> {
  const policy = options.policy ?? DEFAULT_CLASSIFICATION_POLICY;
  const candidates = await selectClassificationCandidates(deps, policy, options.limit);
  return classifyClusters(deps, candidates, { classifier: options.classifier, policy });
}

/** Resolves video ids to their cluster ids (for `classify --video`). */
export async function clustersOfVideos(
  deps: PipelineDeps,
  videoIds: readonly string[],
): Promise<string[]> {
  if (videoIds.length === 0) return [];
  const rows = await deps.db
    .select({ clusterId: videos.clusterId })
    .from(videos)
    .where(inArray(videos.id, [...videoIds]));
  return [...new Set(rows.flatMap((r) => (r.clusterId ? [r.clusterId] : [])))];
}

/** Latest effective classification for the current taxonomy + prompt versions. */
export async function latestClassification(deps: PipelineDeps, clusterId: string) {
  const [row] = await deps.db
    .select()
    .from(classifications)
    .where(
      and(
        eq(classifications.clusterId, clusterId),
        eq(classifications.taxonomyVersion, TAXONOMY_VERSION),
        eq(classifications.promptVersion, PROMPT_VERSION),
      ),
    )
    .orderBy(desc(classifications.createdAt))
    .limit(1);
  return row ?? null;
}
