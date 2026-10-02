import { describe, expect, it } from 'vitest';
import { checkRefreshResults, safeNormalize } from '@vd/adapter-contract';
import { collect, testAdapterContext } from '@vd/adapter-contract/testing';
import { createTwitchAdapter } from './adapter.ts';

/** Live API check. Skipped unless LIVE_API_TESTS=1 and Twitch credentials are set. */
const clientId = process.env['TWITCH_CLIENT_ID'];
const clientSecret = process.env['TWITCH_CLIENT_SECRET'];
describe.skipIf(!process.env['LIVE_API_TESTS'] || !clientId || !clientSecret)(
  'twitch (live)',
  () => {
    it('discovers recent clips for a game and refreshes them by id', async () => {
      const adapter = createTwitchAdapter({
        clientId: clientId ?? '',
        clientSecret: clientSecret ?? '',
      });
      const ctx = testAdapterContext({ now: new Date() });
      const items = await collect(
        adapter.discoverTrending!(
          {
            kind: 'trending',
            params: {
              gameId: process.env['LIVE_TWITCH_GAME_ID'] ?? '509658',
              lookbackHours: 24,
              first: 5,
            },
            region: null,
            limit: 5,
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
      expect(refreshed.some((r) => r.availability === 'available')).toBe(true);
    }, 30_000);
  },
);
