import { describe, expect, it } from 'vitest';
import { safeNormalize } from '@vd/adapter-contract';
import { collect, testAdapterContext } from '@vd/adapter-contract/testing';
import { createBlueskyAdapter } from './adapter.ts';

/** Live API check against the public AppView. Skipped unless LIVE_API_TESTS=1 (no credentials needed). */
describe.skipIf(!process.env['LIVE_API_TESTS'])('bluesky (live)', () => {
  it('searches posts linking to videos and normalizes every candidate', async () => {
    const adapter = createBlueskyAdapter(
      process.env['BLUESKY_APPVIEW_URL'] ? { appviewUrl: process.env['BLUESKY_APPVIEW_URL'] } : {},
    );
    const items = await collect(
      adapter.discoverSearch!(
        {
          kind: 'search',
          params: { q: 'funny', domain: 'youtube.com', pageSize: 25 },
          region: null,
          limit: 25,
        },
        testAdapterContext({ now: new Date() }),
      ),
    );
    expect(items.length).toBeGreaterThan(0);
    const results = items.map((i) => safeNormalize(adapter, i));
    const failures = results.flatMap((r, i) => (r.ok ? [] : [[items[i]?.externalId, r.errors]]));
    expect(failures).toEqual([]);
    expect(results.some((r) => r.ok && r.value.platform === 'youtube')).toBe(true);
  }, 30_000);
});
