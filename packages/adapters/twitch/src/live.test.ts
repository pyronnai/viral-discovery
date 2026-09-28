import { describe, expect, it } from 'vitest';
import { safeNormalize } from '@vd/adapter-contract';
import { collect, testAdapterContext } from '@vd/adapter-contract/testing';
import { createTwitchAdapter } from './adapter.ts';

/** Live API check. Skipped unless LIVE_API_TESTS=1 and Twitch credentials are set. */
const clientId = process.env['TWITCH_CLIENT_ID'];
const clientSecret = process.env['TWITCH_CLIENT_SECRET'];
describe.skipIf(!process.env['LIVE_API_TESTS'] || !clientId || !clientSecret)(
  'twitch (live)',
  () => {
    it('discovers recent clips for a game', async () => {
      const adapter = createTwitchAdapter({
        clientId: clientId ?? '',
        clientSecret: clientSecret ?? '',
      });
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
          testAdapterContext({ now: new Date() }),
        ),
      );
      expect(items.map((i) => safeNormalize(adapter, i)).every((r) => r.ok)).toBe(true);
    }, 30_000);
  },
);
