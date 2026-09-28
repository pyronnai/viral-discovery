import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type { Job } from 'pg-boss';
import { registerHandlers } from './handlers.ts';

const logger = pino({ level: 'silent' });

describe('registerHandlers', () => {
  it('registers nothing when no handlers are provided (Phase 1 state)', async () => {
    const work = vi.fn();
    expect(await registerHandlers({ work } as never, {}, logger)).toEqual([]);
    expect(work).not.toHaveBeenCalled();
  });

  it('validates payloads before invoking a handler', async () => {
    let registered: ((jobs: Job<unknown>[]) => Promise<void>) | undefined;
    const work = vi.fn((_name: string, fn: (jobs: Job<unknown>[]) => Promise<void>) => {
      registered = fn;
      return Promise.resolve('worker-id');
    });
    const handler = vi.fn(() => Promise.resolve());
    await registerHandlers({ work } as never, { 'classify-cluster': handler }, logger);

    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    await registered!([
      { id: 'j1', name: 'classify-cluster', data: { clusterId: id } } as Job<unknown>,
    ]);
    expect(handler).toHaveBeenCalledWith(
      { clusterId: id },
      expect.objectContaining({ jobId: 'j1' }),
    );

    await expect(
      registered!([
        { id: 'j2', name: 'classify-cluster', data: { clusterId: 'bad' } } as Job<unknown>,
      ]),
    ).rejects.toThrow();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
