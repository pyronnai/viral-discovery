import { describe, expect, it } from 'vitest';
import { checkRefreshResults, safeNormalize } from '@vd/adapter-contract';
import { collect, testAdapterContext } from '@vd/adapter-contract/testing';
import { createYouTubeAdapter } from './adapter.ts';

/**
 * Live API checks. Skipped unless LIVE_API_TESTS=1 and YOUTUBE_API_KEY are set.
 * Cost per run, by quota bucket: 2 standard units (two videos.list calls), 1 call from the
 * Search Queries bucket (one search.list page; 100 calls/day default), and 1 unit from the
 * videos.batchGetStats bucket (10,000/day default).
 */
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

  it('runs one targeted search.list page and normalizes the hits', async () => {
    const adapter = createYouTubeAdapter({ apiKey: apiKey ?? '' });
    const items = await collect(
      adapter.discoverSearch!(
        {
          kind: 'search',
          params: {
            q: process.env['LIVE_YOUTUBE_SEARCH_Q'] ?? 'funny animals',
            maxResults: 3,
            pages: 1,
          },
          region: null,
          limit: 3,
        },
        testAdapterContext({ now: new Date() }),
      ),
    );
    expect(items.length).toBeGreaterThan(0);
    expect(items.map((i) => safeNormalize(adapter, i)).every((r) => r.ok)).toBe(true);
  }, 30_000);
});
