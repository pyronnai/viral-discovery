import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type { Job } from 'pg-boss';
import { AdapterRegistry } from '@vd/adapter-contract';
import type { PipelineDeps } from '@vd/pipeline';
import { registerHandlers } from './handlers.ts';
import { pipelineHandlers, type PipelineImpl } from './pipeline-handlers.ts';

const logger = pino({ level: 'silent' });
const deps = { db: {} as never, registry: new AdapterRegistry(), logger } satisfies PipelineDeps;
const id = '0f8fad5b-d9cb-469f-a165-70867728950e';

function fakeImpl(): PipelineImpl {
  return {
    runSourceQuery: vi.fn(() =>
      Promise.resolve({ runId: 'r', status: 'succeeded', itemsNew: 1 } as never),
    ),
    refreshMetrics: vi.fn(() => Promise.resolve({ snapshotsCreated: 1, error: null } as never)),
    scoreVideo: vi.fn(() =>
      Promise.resolve({ status: 'created', result: { state: 'scored', score: 50 } } as never),
    ),
    platformsOf: vi.fn(() => Promise.resolve(new Map([['youtube', [id]]]))),
  };
}

async function run(impl: PipelineImpl, name: string, data: unknown) {
  const workers = new Map<string, (jobs: Job<unknown>[]) => Promise<void>>();
  const work = vi.fn((n: string, fn: (jobs: Job<unknown>[]) => Promise<void>) => {
    workers.set(n, fn);
    return Promise.resolve('w');
  });
  await registerHandlers({ work } as never, pipelineHandlers(deps, impl), logger);
  return workers.get(name)!([{ id: 'j1', name, data } as Job<unknown>]);
}

describe('pipeline job handlers', () => {
  it('registers classify-cluster, discover-source, refresh-metrics, and score-video', async () => {
    const work = vi.fn(() => Promise.resolve('w'));
    const names = await registerHandlers(
      { work } as never,
      pipelineHandlers(deps, fakeImpl()),
      logger,
    );
    expect(names.sort()).toEqual([
      'classify-cluster',
      'discover-source',
      'refresh-metrics',
      'score-video',
    ]);
  });

  it('runs the stored query for discover-source', async () => {
    const impl = fakeImpl();
    await run(impl, 'discover-source', { sourceId: id, sourceQueryId: id, trigger: 'schedule' });
    expect(impl.runSourceQuery).toHaveBeenCalledWith(deps, id, { limit: 100, trigger: 'schedule' });
  });

  it('refreshes per canonical platform', async () => {
    const impl = fakeImpl();
    await run(impl, 'refresh-metrics', { videoIds: [id] });
    expect(impl.refreshMetrics).toHaveBeenCalledWith(deps, {
      platform: 'youtube',
      videoIds: [id],
      limit: 1,
    });
  });

  it('scores a video and refuses unknown algorithm versions', async () => {
    const impl = fakeImpl();
    await run(impl, 'score-video', { videoId: id });
    expect(impl.scoreVideo).toHaveBeenCalledWith(deps, id);
    await expect(
      run(impl, 'score-video', { videoId: id, algorithmVersion: 'breakout-v0' }),
    ).rejects.toThrow(/not available/);
  });

  it('fails the job when discovery fails, so pg-boss retries it', async () => {
    const impl = fakeImpl();
    impl.runSourceQuery = vi.fn(() =>
      Promise.resolve({ runId: 'r', status: 'failed', error: 'HTTP 403' } as never),
    );
    await expect(
      run(impl, 'discover-source', { sourceId: id, sourceQueryId: id, trigger: 'manual' }),
    ).rejects.toThrow(/HTTP 403/);
  });
});
