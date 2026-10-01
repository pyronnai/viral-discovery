import { createThumbnailHasher, scanDuplicates, type ThumbnailHasher } from '@vd/dedupe';
import type { PipelineDeps } from '@vd/pipeline';
import type { JobHandler } from './handlers.ts';

/**
 * scan-duplicates: near-duplicate analysis for the given videos. Idempotent
 * (thumbnails hashed once per URL; suggestions upserted; human decisions never
 * overwritten). A per-video failure is logged, never retried as a job failure —
 * duplicate analysis must not destabilize ingestion.
 */
export function scanDuplicatesHandler(
  deps: PipelineDeps,
  options: { hasher?: ThumbnailHasher | null; scan?: typeof scanDuplicates } = {},
): JobHandler<'scan-duplicates'> {
  const hasher = options.hasher === undefined ? createThumbnailHasher() : options.hasher;
  const scan = options.scan ?? scanDuplicates;
  return async ({ videoIds }, { logger }) => {
    const summary = await scan(deps.db, {
      scope: { videoIds },
      limit: videoIds.length,
      hasher,
      ...(deps.now ? { now: deps.now() } : {}),
    });
    logger.info(
      {
        targets: summary.targets,
        comparisons: summary.comparisons,
        suggested: summary.suggested,
        autoConfirmed: summary.autoConfirmed,
        thumbnails: summary.thumbnails,
      },
      'scan-duplicates finished',
    );
    for (const e of summary.errors)
      logger.warn({ videoId: e.videoId, error: e.message }, 'duplicate analysis failed for video');
  };
}
