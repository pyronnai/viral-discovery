import { z } from 'zod';

/**
 * Pipeline job contracts. Names and payload schemas are defined now so producers
 * and consumers share one source of truth. NO handlers exist in Phase 1 —
 * the worker only creates the queues.
 */
export const JOB_NAMES = [
  'discover-source',
  'normalize-item',
  'refresh-metrics',
  'score-video',
  'classify-cluster',
  'scan-duplicates',
] as const;
export type JobName = (typeof JOB_NAMES)[number];

const uuid = z.uuid();

export const JobPayloadSchemas = {
  'discover-source': z.object({
    sourceId: uuid,
    sourceQueryId: uuid,
    trigger: z.enum(['schedule', 'manual']),
  }),
  'normalize-item': z.object({ discoveryRunId: uuid, rawItemKey: z.string().min(1) }),
  'refresh-metrics': z.object({ videoIds: z.array(uuid).min(1).max(500) }),
  'score-video': z.object({ videoId: uuid, algorithmVersion: z.string().min(1).optional() }),
  'classify-cluster': z.object({ clusterId: uuid }),
  /** Near-duplicate analysis for newly ingested (or changed) videos. */
  'scan-duplicates': z.object({ videoIds: z.array(uuid).min(1).max(500) }),
} satisfies Record<JobName, z.ZodType>;

export type JobPayload<N extends JobName> = z.infer<(typeof JobPayloadSchemas)[N]>;

export function parseJobPayload<N extends JobName>(name: N, data: unknown): JobPayload<N> {
  return JobPayloadSchemas[name].parse(data) as JobPayload<N>;
}
