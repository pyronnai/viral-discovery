import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { AdapterRegistry } from '@vd/adapter-contract';
import { createFakeClassifier } from '@vd/classification';
import type { PipelineDeps } from '@vd/pipeline';
import { classifyClusterHandler } from './classify-handler.ts';

const logger = pino({ level: 'silent' });
const deps = { db: {} as never, registry: new AdapterRegistry(), logger } satisfies PipelineDeps;
const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
const meta = { jobId: 'j', logger };

describe('classify-cluster handler', () => {
  it('is a no-op when no classifier is configured', async () => {
    const classify = vi.fn();
    await classifyClusterHandler(
      deps,
      { configured: false, reason: 'none' },
      classify,
    )({ clusterId: id }, meta);
    expect(classify).not.toHaveBeenCalled();
  });

  it('throws only for retryable failures so the queue retries them', async () => {
    const setup = {
      configured: true as const,
      classifier: createFakeClassifier({ respond: () => null }),
    };
    const retryable = vi.fn(() =>
      Promise.resolve({
        clusterId: id,
        status: 'failed' as const,
        error: { kind: 'rate_limited', message: 'x', retryable: true, details: [] },
      }),
    );
    await expect(
      classifyClusterHandler(deps, setup, retryable)({ clusterId: id }, meta),
    ).rejects.toThrow(/will retry/);
    const permanent = vi.fn(() =>
      Promise.resolve({
        clusterId: id,
        status: 'failed' as const,
        error: { kind: 'invalid_output', message: 'x', retryable: false, details: [] },
      }),
    );
    await expect(
      classifyClusterHandler(deps, setup, permanent)({ clusterId: id }, meta),
    ).resolves.toBeUndefined();
  });
});
