import { inArray } from 'drizzle-orm';
import { schema } from '@vd/db';
import {
  refreshMetrics,
  runSourceQuery,
  scoreVideo,
  PipelineError,
  type PipelineDeps,
} from '@vd/pipeline';
import { DEFAULT_SCORING_CONFIG } from '@vd/scoring';
import type { JobHandlerMap } from './handlers.ts';

/** Pipeline functions, injectable so handler wiring can be tested without a database. */
export interface PipelineImpl {
  runSourceQuery: typeof runSourceQuery;
  refreshMetrics: typeof refreshMetrics;
  scoreVideo: typeof scoreVideo;
  platformsOf: (deps: PipelineDeps, videoIds: string[]) => Promise<Map<string, string[]>>;
}

async function platformsOf(deps: PipelineDeps, videoIds: string[]) {
  const rows = await deps.db
    .select({ id: schema.videos.id, platform: schema.videos.platform })
    .from(schema.videos)
    .where(inArray(schema.videos.id, videoIds));
  const byPlatform = new Map<string, string[]>();
  for (const r of rows) byPlatform.set(r.platform, [...(byPlatform.get(r.platform) ?? []), r.id]);
  return byPlatform;
}

const DEFAULT_IMPL: PipelineImpl = { runSourceQuery, refreshMetrics, scoreVideo, platformsOf };

/**
 * Handlers for the Phase 1 job contracts. Each is idempotent: discovery dedupes
 * videos and sightings per run, refresh appends snapshots (unique per time), and
 * scoring stores a row only when the evidence fingerprint changed.
 */
export function pipelineHandlers(
  deps: PipelineDeps,
  impl: PipelineImpl = DEFAULT_IMPL,
  options: { discoveryLimit?: number } = {},
): JobHandlerMap {
  return {
    'discover-source': async (payload, { logger }) => {
      const run = await impl.runSourceQuery(deps, payload.sourceQueryId, {
        limit: options.discoveryLimit ?? 100,
        trigger: payload.trigger,
      });
      logger.info(
        { runId: run.runId, status: run.status, itemsNew: run.itemsNew },
        'discovery run finished',
      );
      if (run.status === 'failed') throw new PipelineError(run.error ?? 'discovery failed');
    },
    'refresh-metrics': async (payload, { logger }) => {
      const byPlatform = await impl.platformsOf(deps, payload.videoIds);
      for (const [platform, videoIds] of byPlatform) {
        const summary = await impl.refreshMetrics(deps, {
          platform,
          videoIds,
          limit: videoIds.length,
        });
        logger.info({ platform, snapshots: summary.snapshotsCreated }, 'metrics refreshed');
        if (summary.error) throw new PipelineError(summary.error);
      }
    },
    'score-video': async (payload, { logger }) => {
      if (payload.algorithmVersion && payload.algorithmVersion !== DEFAULT_SCORING_CONFIG.version) {
        throw new PipelineError(
          `algorithm version "${payload.algorithmVersion}" is not available (current: ${DEFAULT_SCORING_CONFIG.version})`,
        );
      }
      const r = await impl.scoreVideo(deps, payload.videoId);
      logger.info(
        {
          videoId: payload.videoId,
          status: r.status,
          state: r.result.state,
          score: r.result.score,
        },
        'video scored',
      );
    },
  };
}
