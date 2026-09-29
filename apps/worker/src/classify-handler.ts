import type { ClassifierSetup } from '@vd/classification';
import { classifyCluster, type PipelineDeps } from '@vd/pipeline';
import type { JobHandler } from './handlers.ts';

/**
 * classify-cluster: idempotent (versions + input fingerprint), retryable
 * (throws only for retryable provider failures so pg-boss retries), and a
 * no-op with a warning when no classifier is configured.
 */
export function classifyClusterHandler(
  deps: PipelineDeps,
  setup: ClassifierSetup,
  classify: typeof classifyCluster = classifyCluster,
): JobHandler<'classify-cluster'> {
  return async ({ clusterId }, { logger }) => {
    if (!setup.configured) {
      logger.warn({ clusterId, reason: setup.reason }, 'classifier not configured; job skipped');
      return;
    }
    const r = await classify(deps, clusterId, { classifier: setup.classifier });
    logger.info({ clusterId, status: r.status, error: r.error?.kind }, 'classify-cluster finished');
    if (r.status === 'failed' && r.error?.retryable) {
      throw new Error(`classification failed (${r.error.kind}); will retry`);
    }
  };
}
