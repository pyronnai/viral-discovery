/**
 * TEST FIXTURE ONLY — not a platform adapter.
 * An in-memory adapter that exercises the contract and the test kit. It performs
 * no network access and represents no real platform.
 */
import { buildReadings, metricValue } from '@vd/core';
import type { AdapterContext, DiscoveryRequest, SourceAdapter } from '../adapter.ts';
import { AdapterManifestSchema, type AdapterManifestInput } from '../manifest.ts';
import type { NormalizedVideo, RawItem } from '../normalized.ts';

export interface FixturePayload {
  id: string;
  title: string;
  author: string;
  views: number;
  publishedAt: string;
}

export const FIXTURE_ADAPTER_ID = 'fixture-source';

export function createFixtureAdapter(
  items: readonly FixturePayload[] = [],
  manifestOverrides: Partial<AdapterManifestInput> = {},
): SourceAdapter {
  const manifest = AdapterManifestSchema.parse({
    id: FIXTURE_ADAPTER_ID,
    platform: 'fixture',
    displayName: 'Fixture source (tests only)',
    version: '0.0.1',
    accessMethod: 'manual',
    capabilities: ['discovery.trending', 'normalize'],
    metricsProvided: ['views'],
    quotaBuckets: [{ name: 'default', unit: 'requests', defaultDailyBudget: null }],
    docsPath: 'packages/adapters/contract/src/testing/fixture-adapter.ts',
    ...manifestOverrides,
  });

  return {
    manifest,
    async *discoverTrending(req: DiscoveryRequest, ctx: AdapterContext) {
      for (const item of items.slice(0, req.limit)) {
        if (ctx.signal.aborted) return;
        if (!ctx.quota.tryConsume('default', 1)) return;
        yield toRaw(item, ctx.now());
        await Promise.resolve();
      }
    },
    normalize(raw: RawItem): NormalizedVideo {
      const p = raw.payload as Partial<FixturePayload> | null;
      if (!p || typeof p.id !== 'string' || typeof p.views !== 'number') {
        throw new Error('malformed fixture payload');
      }
      return {
        platform: 'fixture',
        platformVideoId: p.id,
        canonicalUrl: `https://fixture.invalid/v/${encodeURIComponent(p.id)}`,
        creator: {
          platform: 'fixture',
          platformCreatorId: p.author ?? null,
          handle: p.author ?? null,
          displayName: p.author ?? null,
          profileUrl: null,
          followerCount: null,
        },
        title: p.title ?? null,
        caption: null,
        publishedAt: p.publishedAt ? new Date(p.publishedAt) : null,
        durationMs: null,
        thumbnailUrl: null,
        language: null,
        contentOrigin: 'discovered_external',
        availability: 'available',
        metrics: buildReadings({ views: metricValue(p.views) }),
        observedAt: raw.fetchedAt,
      };
    },
  };
}

export function toRaw(item: FixturePayload, fetchedAt: Date): RawItem {
  return {
    adapterId: FIXTURE_ADAPTER_ID,
    externalId: item.id,
    fetchedAt,
    payload: item,
    context: {},
  };
}
