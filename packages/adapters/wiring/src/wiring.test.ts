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
    ]);
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
