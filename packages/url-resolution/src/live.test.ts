import { describe, expect, it } from 'vitest';
import { expandTikTokShortLink } from './tiktok-short-links.ts';

/**
 * Live check against TikTok. Skipped unless LIVE_API_TESTS=1 and LIVE_TIKTOK_SHORT_URL
 * (e.g. https://www.tiktok.com/t/<code>/) are set.
 */
const url = process.env['LIVE_TIKTOK_SHORT_URL'];
describe.skipIf(!process.env['LIVE_API_TESTS'] || !url)('TikTok short link (live)', () => {
  it('expands to a canonical video within the allowlist', async () => {
    const result = await expandTikTokShortLink(url ?? '');
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok)
      expect(result.resolved.canonicalUrl).toMatch(
        /^https:\/\/www\.tiktok\.com\/@[^/]+\/video\/\d+$/,
      );
  }, 15_000);
});
