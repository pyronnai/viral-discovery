import { describe, expect, it } from 'vitest';
import { safeNormalize } from '@vd/adapter-contract';
import { testAdapterContext } from '@vd/adapter-contract/testing';
import { createManualUrlAdapter } from './adapter.ts';

/**
 * Live TikTok oEmbed check. Skipped unless LIVE_API_TESTS=1 and LIVE_TIKTOK_URL
 * (a public https://www.tiktok.com/@user/video/<id> URL) are set.
 */
const url = process.env['LIVE_TIKTOK_URL'];
describe.skipIf(!process.env['LIVE_API_TESTS'] || !url)('manual-url TikTok oEmbed (live)', () => {
  it('enriches a public TikTok URL without credentials and reports no metrics', async () => {
    const adapter = createManualUrlAdapter();
    const raw = await adapter.lookupUrl!(url ?? '', testAdapterContext({ now: new Date() }));
    expect(raw).not.toBeNull();
    const result = safeNormalize(adapter, raw!);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.platform).toBe('tiktok');
      expect(result.value.metrics).toBeNull();
      expect(result.value.creator?.displayName ?? result.value.creator?.handle).toBeTruthy();
    }
  }, 30_000);
});
