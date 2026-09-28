import { describe, expect, it } from 'vitest';
import { checkRefreshResults, safeNormalize } from '@vd/adapter-contract';
import { collect, testAdapterContext } from '@vd/adapter-contract/testing';
import { createYouTubeAdapter } from './adapter.ts';

/** Live API check. Skipped unless LIVE_API_TESTS=1 and YOUTUBE_API_KEY are set (costs 2 quota units). */
const apiKey = process.env['YOUTUBE_API_KEY'];
describe.skipIf(!process.env['LIVE_API_TESTS'] || !apiKey)('youtube (live)', () => {
  it('discovers a mostPopular chart and refreshes it with batchGetStats', async () => {
    const adapter = createYouTubeAdapter({ apiKey: apiKey ?? '' });
    const ctx = testAdapterContext({ now: new Date() });
    const items = await collect(
      adapter.discoverTrending!(
        {
          kind: 'trending',
          params: { regionCode: process.env['LIVE_YOUTUBE_REGION'] ?? 'US', maxResults: 3 },
          region: null,
          limit: 3,
        },
        ctx,
      ),
    );
    expect(items.length).toBeGreaterThan(0);
    const videos = items.map((i) => safeNormalize(adapter, i));
    expect(videos.every((v) => v.ok)).toBe(true);
    const refs = videos.flatMap((v) =>
      v.ok
        ? [{ platformVideoId: v.value.platformVideoId, canonicalUrl: v.value.canonicalUrl }]
        : [],
    );
    const refreshed = await adapter.refreshMetrics!(refs, ctx);
    expect(checkRefreshResults(adapter, refreshed).every((r) => r.ok)).toBe(true);
  }, 30_000);
});
