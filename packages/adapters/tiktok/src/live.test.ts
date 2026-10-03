import { describe, expect, it } from 'vitest';
import { checkRefreshResults, safeNormalize } from '@vd/adapter-contract';
import { collect, testAdapterContext } from '@vd/adapter-contract/testing';
import { createTikTokAdapter } from './adapter.ts';
import { createBrightDataProvider } from './brightdata.ts';

/**
 * Live Bright Data check. BILLED per delivered record (≈ 3 search + 1 lookup records),
 * so it needs its own flag on top of LIVE_API_TESTS:
 *   LIVE_API_TESTS=1 LIVE_BRIGHTDATA_TESTS=1 BRIGHTDATA_API_TOKEN=… pnpm vitest run packages/adapters/tiktok
 */
const token = process.env['BRIGHTDATA_API_TOKEN'];
describe.skipIf(!process.env['LIVE_API_TESTS'] || !process.env['LIVE_BRIGHTDATA_TESTS'] || !token)(
  'tiktok via Bright Data (live)',
  () => {
    it(
      'discovers public posts by keyword and refreshes one by URL',
      async () => {
        const adapter = createTikTokAdapter({
          provider: createBrightDataProvider({ token: token ?? '' }),
        });
        const ctx = testAdapterContext({ now: new Date() });
        const items = await collect(
          adapter.discoverSearch!(
            {
              kind: 'search',
              params: { q: process.env['LIVE_TIKTOK_KEYWORD'] ?? 'funny animals', maxResults: 3 },
              region: null,
              limit: 3,
            },
            ctx,
          ),
        );
        const videos = items.flatMap((i) => {
          const r = safeNormalize(adapter, i);
          return r.ok ? [r.value] : [];
        });
        expect(videos.length).toBeGreaterThan(0);
        const first = videos[0]!;
        expect(first.platform).toBe('tiktok');
        expect(first.canonicalUrl).toMatch(/^https:\/\/www\.tiktok\.com\/@[^/]+\/video\/\d+$/);
        expect(first.metrics?.views.kind).toBe('value');
        const results = await adapter.refreshMetrics!(
          [{ platformVideoId: first.platformVideoId, canonicalUrl: first.canonicalUrl }],
          ctx,
        );
        expect(checkRefreshResults(adapter, results).every((c) => c.ok)).toBe(true);
        expect(results[0]?.availability).toBe('available');
      },
      20 * 60_000,
    );
  },
);
