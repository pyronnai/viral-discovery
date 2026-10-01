import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { AdapterRegistry } from '@vd/adapter-contract';
import type { ScanSummary } from '@vd/dedupe';
import type { PipelineDeps } from '@vd/pipeline';
import { scanDuplicatesHandler } from './duplicates-handler.ts';

const logger = pino({ level: 'silent' });
const deps = { db: {} as never, registry: new AdapterRegistry(), logger } satisfies PipelineDeps;
const id = '0f8fad5b-d9cb-469f-a165-70867728950e';

const summary = (errors: ScanSummary['errors'] = []): ScanSummary => ({
  targets: 1,
  thumbnails: {},
  candidatesGenerated: 0,
  comparisons: 0,
  suggested: 0,
  autoConfirmed: 0,
  withdrawn: 0,
  keptDecisions: 0,
  errors,
  pairs: [],
});

describe('scan-duplicates handler', () => {
  it('scans exactly the given videos', async () => {
    const scan = vi.fn(() => Promise.resolve(summary()));
    await scanDuplicatesHandler(deps, { hasher: null, scan })(
      { videoIds: [id] },
      { jobId: 'j', logger },
    );
    expect(scan).toHaveBeenCalledWith(deps.db, {
      scope: { videoIds: [id] },
      limit: 1,
      hasher: null,
    });
  });

  it('does not fail the job for per-video analysis errors', async () => {
    const scan = vi.fn(() => Promise.resolve(summary([{ videoId: id, message: 'boom' }])));
    await expect(
      scanDuplicatesHandler(deps, { hasher: null, scan })(
        { videoIds: [id] },
        { jobId: 'j', logger },
      ),
    ).resolves.toBeUndefined();
  });
});
