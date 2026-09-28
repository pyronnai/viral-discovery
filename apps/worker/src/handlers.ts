import type { Job, PgBoss } from 'pg-boss';
import { parseJobPayload, type JobName, type JobPayload } from '@vd/core';
import type { Logger } from '@vd/config';

export type JobHandler<N extends JobName> = (
  payload: JobPayload<N>,
  meta: { jobId: string; logger: Logger },
) => Promise<void>;

/** Handlers are opt-in per job. Phase 1 registers none. */
export type JobHandlerMap = { [N in JobName]?: JobHandler<N> };

type Worker = Pick<PgBoss, 'work'>;

/**
 * Registers only the handlers provided. Payloads are validated against the shared
 * Zod schema before a handler runs; invalid payloads fail the job (and are retried
 * per queue policy) instead of reaching handler code.
 */
export async function registerHandlers(
  boss: Worker,
  handlers: JobHandlerMap,
  logger: Logger,
): Promise<JobName[]> {
  const registered: JobName[] = [];
  for (const [name, handler] of Object.entries(handlers) as [JobName, JobHandler<JobName>][]) {
    await boss.work<unknown>(name, async (jobs: Job<unknown>[]) => {
      for (const job of jobs) {
        const jobLogger = logger.child({ job: name, jobId: job.id });
        const payload = parseJobPayload(name, job.data);
        await handler(payload, { jobId: job.id, logger: jobLogger });
      }
    });
    registered.push(name);
  }
  return registered;
}
