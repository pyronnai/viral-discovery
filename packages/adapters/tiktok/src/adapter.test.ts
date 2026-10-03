import { describe, expect, it } from 'vitest';
import { checkRefreshResults, safeNormalize, type RawItem } from '@vd/adapter-contract';
import { collect, describeAdapterContract, testAdapterContext } from '@vd/adapter-contract/testing';
import fixture from '../fixtures/public-posts.json' with { type: 'json' };
import { canonicalOf, createTikTokAdapter } from './adapter.ts';
import type { TikTokPublicPost } from './provider.ts';
import { createFakeTikTokProvider } from './testing.ts';

const posts = fixture as TikTokPublicPost[];
const [cat, fail, carousel] = posts as [TikTokPublicPost, TikTokPublicPost, TikTokPublicPost];
const fetchedAt = new Date('2026-10-03T12:00:00Z');
const item = (post: TikTokPublicPost, externalId = post.videoId): RawItem => ({
  adapterId: 'tiktok',
  externalId,
  fetchedAt,
  payload: { kind: 'post', provider: 'fake', post },
  context: {},
});

async function search(
  provider = createFakeTikTokProvider(posts, {
    errors: [{ input: 'funny', code: 'unavailable', message: 'gone' }],
  }),
) {
  const adapter = createTikTokAdapter({ provider });
  const ctx = testAdapterContext({ now: fetchedAt });
  const items = await collect(
    adapter.discoverSearch!(
      { kind: 'search', params: { q: 'funny' }, region: null, limit: 50 },
      ctx,
    ),
  );
  return { adapter, items, ctx, provider };
}

describeAdapterContract('tiktok', {
  create: () => createTikTokAdapter({ provider: createFakeTikTokProvider(posts) }),
  validFixtures: [item(cat, 'full'), item(fail, 'partial-metrics')],
  invalidFixtures: [
    item(carousel, 'carousel'),
    {
      adapterId: 'tiktok',
      externalId: 'provider-error',
      fetchedAt,
      payload: {
        kind: 'error',
        provider: 'fake',
        error: { input: 'x', code: 'unavailable', message: 'gone' },
      },
      context: {},
    },
  ],
});

describe('provider-neutral TikTok adapter', () => {
  it('takes its display name and access method from the provider (nothing paid assumed)', () => {
    const { manifest } = createTikTokAdapter({ provider: createFakeTikTokProvider(posts) });
    expect(manifest).toMatchObject({
      id: 'tiktok',
      platform: 'tiktok',
      displayName: 'TikTok via fake test source',
      accessMethod: 'official_api',
    });
    expect(manifest.quotaBuckets.map((b) => b.name)).toEqual(['requests']);
  });

  it('normalizes a public post to the shared NormalizedVideo shape', async () => {
    const { adapter, items } = await search();
    const r = safeNormalize(adapter, items[0]!);
    if (!r.ok) throw new Error(r.errors.join('; '));
    expect(r.value).toMatchObject({
      platform: 'tiktok',
      platformVideoId: '7550000000000000001',
      canonicalUrl: 'https://www.tiktok.com/@fixture.pets/video/7550000000000000001',
      caption: 'when the cat hears the treat bag #funny #cat',
      durationMs: 18_000,
      thumbnailUrl: 'https://p16-sign.tiktokcdn-us.com/fixture-cover-1.jpeg',
      creator: { handle: 'fixture.pets', platformCreatorId: '6900000000000000001' },
    });
    expect(r.value.publishedAt?.toISOString()).toBe('2026-10-03T08:00:00.000Z');
    expect(items[0]).toMatchObject({
      observationKey: 'search:funny',
      context: { query: 'funny', rank: 1, provider: 'fake', hashtags: ['funny', 'cat'] },
    });
  });

  it('keeps missing metrics unavailable and explicit zeros as zero', async () => {
    const { adapter, items } = await search();
    const r = safeNormalize(adapter, items[1]!);
    if (!r.ok) throw new Error('fixture should normalize');
    expect(r.value.metrics).toMatchObject({
      views: { kind: 'value', value: 41_000 },
      likes: { kind: 'unavailable', reason: 'unknown' },
      comments: { kind: 'value', value: 0 },
      shares: { kind: 'value', value: 0 },
    });
    expect(r.value.durationMs).toBe(9_500);
  });

  it('quarantines photo/carousel posts and source-reported errors instead of dropping them', async () => {
    const { adapter, items } = await search();
    const outcomes = items.map((i) => {
      const r = safeNormalize(adapter, i);
      return r.ok ? 'ok' : r.errors.join(' ');
    });
    expect(outcomes).toEqual([
      'ok',
      'ok',
      expect.stringMatching(/photo\/carousel posts are not videos/),
      expect.stringMatching(/fake could not deliver this item \(unavailable\): gone/),
    ]);
  });

  it('derives the canonical identity through the shared URL rules', () => {
    expect(canonicalOf(fail)).toEqual({
      platformVideoId: '7550000000000000002',
      canonicalUrl: 'https://www.tiktok.com/@fixture.fails/video/7550000000000000002',
    });
    expect(() =>
      canonicalOf({ ...cat, url: 'https://www.tiktok.com/@x/video/1', creatorUsername: null }),
    ).toThrow(/no canonical TikTok URL/);
  });

  it('meters source requests and passes source failures through', async () => {
    const { ctx, provider } = await search();
    expect(ctx.quota.usage()).toEqual({ requests: 1 });
    expect(provider.calls).toEqual([
      { op: 'search', input: { keyword: 'funny', limit: 20, country: null } },
    ]);
    await expect(
      search(createFakeTikTokProvider(posts, { fail: new Error('source unavailable') })),
    ).rejects.toThrow('source unavailable');
  });

  it('looks up URLs in batches, positionally, and refreshes without inventing data', async () => {
    const provider = createFakeTikTokProvider(posts, { maxLookupBatch: 2 });
    const adapter = createTikTokAdapter({ provider });
    const urls = [
      'https://www.tiktok.com/@fixture.pets/video/7550000000000000001',
      'https://www.tiktok.com/@fixture.fails/video/7550000000000000002',
      'https://www.tiktok.com/@gone/video/7550000000000000009',
      'https://example.com/not-tiktok',
    ];
    const found = await adapter.lookupUrls!(urls, testAdapterContext());
    expect(found.map((i) => i?.externalId ?? null)).toEqual([
      '7550000000000000001',
      '7550000000000000002',
      null,
      null,
    ]);
    expect(provider.calls.map((c) => c.op)).toEqual(['lookup', 'lookup']); // 3 valid URLs, batch 2
    const results = await adapter.refreshMetrics!(
      urls.slice(0, 3).map((canonicalUrl) => ({
        canonicalUrl,
        platformVideoId: /video\/(\d+)/.exec(canonicalUrl)![1]!,
      })),
      testAdapterContext(),
    );
    expect(checkRefreshResults(adapter, results).every((c) => c.ok)).toBe(true);
    expect(results.map((r) => r.availability)).toEqual(['available', 'available', 'unknown']);
    expect(results[2]!.metrics).toBeNull();
  });
});
