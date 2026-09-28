import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { JOB_NAMES } from '@vd/core';
import { loadConfig } from '@vd/config';
import { buildAdapterRegistry } from './adapters.ts';
import { startWorker } from './worker.ts';

/**
 * Requires a migrated database. Runs only when TEST_DATABASE_URL is set, so
 * `pnpm test` stays green on machines without Postgres.
 */
const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('worker startup (integration)', () => {
  it('starts with no adapters and no schedules, creates queues, and stops cleanly', async () => {
    const config = loadConfig({
      DATABASE_URL: url,
      PGBOSS_SCHEMA: 'pgboss_test',
      LOG_LEVEL: 'silent',
    });
    const worker = await startWorker({
      config,
      logger: pino({ level: 'silent' }),
      registry: buildAdapterRegistry(),
      handlers: {},
    });
    try {
      const queues = await worker.boss.getQueues([...JOB_NAMES]);
      expect(queues.map((q) => q.name).sort()).toEqual([...JOB_NAMES].sort());
      expect(await worker.boss.getSchedules()).toEqual([]);
    } finally {
      await worker.stop();
    }
  }, 30_000);

  it('fails fast with a clear error when the database is unreachable', async () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://nobody:x@127.0.0.1:1/none',
      LOG_LEVEL: 'silent',
    });
    await expect(
      startWorker({
        config,
        logger: pino({ level: 'silent' }),
        registry: buildAdapterRegistry(),
        handlers: {},
      }),
    ).rejects.toThrow(/database unreachable/);
  });
});
