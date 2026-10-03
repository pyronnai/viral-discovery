import { describe, expect, it } from 'vitest';
import { buildAdapterRegistry, unconfiguredMessage } from './index.ts';

describe('buildAdapterRegistry', () => {
  it('registers credential-free adapters with no configuration at all', () => {
    const { registry, statuses } = buildAdapterRegistry({});
    expect(
      registry
        .list()
        .map((a) => a.manifest.id)
        .sort(),
    ).toEqual(['bluesky', 'manual-url']);
    expect(statuses.filter((s) => !s.configured).map((s) => [s.id, s.missingEnv])).toEqual([
      ['youtube', ['YOUTUBE_API_KEY']],
      ['twitch', ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET']],
      ['tiktok', ['BRIGHTDATA_API_TOKEN']],
    ]);
  });

  it('classifies sightings per adapter: only manual submission is provenance', () => {
    expect(buildAdapterRegistry({}).sightingRoles).toEqual({
      youtube: 'propagation',
      twitch: 'propagation',
      bluesky: 'propagation',
      'manual-url': 'provenance',
      tiktok: 'propagation',
    });
  });

  it('keeps TikTok public discovery disabled until a provider token is configured', () => {
    const off = buildAdapterRegistry({});
    expect(off.registry.has('tiktok')).toBe(false);
    expect(off.statuses.find((s) => s.id === 'tiktok')).toMatchObject({
      configured: false,
      displayName: 'TikTok public data (no provider configured)',
      missingEnv: ['BRIGHTDATA_API_TOKEN'],
    });
    // The token alone selects Bright Data; the value never appears in any status/message.
    const on = buildAdapterRegistry({ BRIGHTDATA_API_TOKEN: 'secret-token-value' });
    expect(on.registry.has('tiktok')).toBe(true);
    const status = on.statuses.find((s) => s.id === 'tiktok');
    expect(status).toMatchObject({
      configured: true,
      displayName: 'TikTok public data via Bright Data',
    });
    expect(JSON.stringify(on.statuses)).not.toContain('secret-token-value');
    // An explicit "none" wins over a present token.
    const disabled = buildAdapterRegistry({
      TIKTOK_PUBLIC_PROVIDER: 'none',
      BRIGHTDATA_API_TOKEN: 'secret-token-value',
    });
    expect(disabled.registry.has('tiktok')).toBe(false);
    expect(unconfiguredMessage(off.statuses, 'tiktok')).toBe(
      'adapter "tiktok" is not configured: set BRIGHTDATA_API_TOKEN (see docs/sources/tiktok.md)',
    );
  });

  it('registers each adapter independently once its own variables are set', () => {
    const { registry } = buildAdapterRegistry({
      YOUTUBE_API_KEY: 'k',
      TWITCH_CLIENT_ID: 'only-id',
    });
    expect(registry.has('youtube')).toBe(true);
    expect(registry.has('twitch')).toBe(false);
  });

  it('explains unconfigured and planned adapters without printing values', () => {
    const { statuses } = buildAdapterRegistry({
      TWITCH_CLIENT_ID: 'visible-id',
      TWITCH_CLIENT_SECRET: undefined,
    });
    const msg = unconfiguredMessage(statuses, 'twitch');
    expect(msg).toBe(
      'adapter "twitch" is not configured: set TWITCH_CLIENT_SECRET (see docs/sources/twitch.md)',
    );
    expect(msg).not.toContain('visible-id');
    expect(unconfiguredMessage(statuses, 'reddit')).toMatch(
      /planned but not implemented.*approval/,
    );
    expect(unconfiguredMessage(statuses, 'bluesky')).toBeUndefined();
  });
});
