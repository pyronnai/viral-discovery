import type { PgBoss, Queue } from 'pg-boss';
import { JOB_NAMES, type JobName } from '@vd/core';

/**
 * Per-queue policy. Values are conservative defaults for future handlers; tune
 * when real handlers exist. Changing these later requires boss.updateQueue()
 * because createQueue() never modifies an existing queue.
 */
export const QUEUE_OPTIONS: Record<JobName, Omit<Queue, 'name'>> = {
  'discover-source': { retryLimit: 3, retryBackoff: true, expireInSeconds: 15 * 60 },
  'normalize-item': { retryLimit: 3, retryBackoff: true, expireInSeconds: 5 * 60 },
  'refresh-metrics': { retryLimit: 3, retryBackoff: true, expireInSeconds: 10 * 60 },
  'score-video': { retryLimit: 2, retryBackoff: true, expireInSeconds: 5 * 60 },
  'classify-cluster': { retryLimit: 2, retryBackoff: true, expireInSeconds: 10 * 60 },
  'scan-duplicates': { retryLimit: 2, retryBackoff: true, expireInSeconds: 10 * 60 },
};

type QueueAdmin = Pick<PgBoss, 'createQueue' | 'getQueue'>;

/** Idempotently creates every pipeline queue. Returns names that were newly created. */
export async function ensureQueues(boss: QueueAdmin): Promise<JobName[]> {
  const created: JobName[] = [];
  for (const name of JOB_NAMES) {
    const existing = await boss.getQueue(name);
    if (!existing) {
      await boss.createQueue(name, QUEUE_OPTIONS[name]);
      created.push(name);
    }
  }
  return created;
}
