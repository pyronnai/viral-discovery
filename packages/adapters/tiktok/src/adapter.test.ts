import { describe, expect, it } from 'vitest';
import {
  QuotaBudgetExhaustedError,
  UpstreamError,
  checkRefreshResults,
  safeNormalize,
  type FetchLike,
  type RawItem,
} from '@vd/adapter-contract';
import {
  collect,
  createFakeFetch,
  describeAdapterContract,
  route,
  testAdapterContext,
} from '@vd/adapter-contract/testing';
import snapshot from '../fixtures/brightdata-snapshot-funny.json' with { type: 'json' };
import { createTikTokAdapter, canonicalOf } from './adapter.ts';
import { createBrightDataProvider, mapBrightDataRecord } from './brightdata.ts';

const TOKEN = 'bd-fixture-token-DO-NOT-LOG-9c1e';
const SNAP = 's_fixture123';
const noSleep = () => Promise.resolve();

/** A scripted Bright Data API: trigger → progress (running, ready) → snapshot. */
function brightdata(records: unknown = snapshot, progress = ['running', 'ready']) {
  return createFakeFetch([
    route('/datasets/v3/trigger', { body: { snapshot_id: SNAP } }),
    route(
      `/datasets/v3/progress/${SNAP}`,
      progress.map((status) => ({ body: { status } })),
    ),
    route(`/datasets/v3/snapshot/${SNAP}`, { body: records }),
  ]);
}

function adapterWith(fetch: FetchLike, extra: { maxWaitMs?: number } = {}) {
  return createTikTokAdapter({
    provider: createBrightDataProvider({ token: TOKEN, fetch, sleep: noSleep, ...extra }),
  });
}

async function search(fetch = brightdata(), params: Record<string, unknown> = { q: 'funny' }) {
  const adapter = adapterWith(fetch);
  const ctx = testAdapterContext({ now: new Date('2026-10-03T12:00:00Z') });
  const items = await collect(
    adapter.discoverSearch!({ kind: 'search', params, region: null, limit: 50 }, ctx),
  );
  return { adapter, items, ctx, fetch };
}

const fetchedAt = new Date('2026-10-03T12:00:00Z');
const postItem = (record: unknown, externalId: string): RawItem => {
  const mapped = mapBrightDataRecord(record);
  if (!mapped.ok) throw new Error('fixture record is not valid');
  return {
    adapterId: 'tiktok',
    externalId,
    fetchedAt,
    payload: { kind: 'post', provider: 'brightdata', post: mapped.post },
    context: {},
  };
};

describeAdapterContract('tiktok', {
  create: () => adapterWith(brightdata()),
  validFixtures: [postItem(snapshot[0], 'full'), postItem(snapshot[1], 'partial-metrics')],
  invalidFixtures: [
    postItem(snapshot[2], 'carousel'),
    {
      adapterId: 'tiktok',
      externalId: 'provider-error',
      fetchedAt,
      payload: {
        kind: 'error',
        provider: 'brightdata',
        error: { input: 'x', code: 'dead_page', message: 'gone' },
      },
      context: {},
    },
  ],
});

describe('A. search result normalization', () => {
  it('maps a full public post to the shared NormalizedVideo shape', async () => {
    const { adapter, items } = await search();
    const result = safeNormalize(adapter, items[0]!);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      platform: 'tiktok',
      platformVideoId: '7550000000000000001',
      canonicalUrl: 'https://www.tiktok.com/@fixture.pets/video/7550000000000000001',
      title: null,
      caption: 'when the cat hears the treat bag #funny #cat',
      thumbnailUrl: 'https://p16-sign.tiktokcdn-us.com/fixture-cover-1.jpeg',
      availability: 'available',
      creator: {
        platform: 'tiktok',
        platformCreatorId: '6900000000000000001',
        handle: 'fixture.pets',
        displayName: null,
        profileUrl: 'https://www.tiktok.com/@fixture.pets',
        followerCount: 120000,
      },
    });
    expect(items[0]).toMatchObject({
      observationKey: 'search:funny',
      context: { query: 'funny', rank: 1, provider: 'brightdata', hashtags: ['funny', 'cat'] },
    });
  });

  it('quarantines carousels, provider errors and malformed records instead of dropping them', async () => {
    const { adapter, items } = await search();
    const outcomes = items.map((i) => {
      const r = safeNormalize(adapter, i);
      return r.ok ? 'ok' : r.errors.join(' ');
    });
    expect(outcomes[0]).toBe('ok');
    expect(outcomes[1]).toBe('ok');
    expect(outcomes[2]).toMatch(/photo\/carousel posts are not videos/);
    expect(outcomes.slice(3)).toEqual([
      expect.stringMatching(/brightdata could not deliver this item \(dead_page\)/),
      expect.stringMatching(/\(malformed_record\): record has no TikTok video id/),
    ]);
  });
});

describe('B. canonical TikTok identity', () => {
  it('uses the shared URL-identity rules (numeric id; documented URL form)', () => {
    const base = mapBrightDataRecord(snapshot[0]);
    if (!base.ok) throw new Error('fixture');
    expect(canonicalOf(base.post)).toEqual({
      platformVideoId: '7550000000000000001',
      canonicalUrl: 'https://www.tiktok.com/@fixture.pets/video/7550000000000000001',
    });
    // No URL from the provider: built from username + id.
    expect(canonicalOf({ ...base.post, url: null }).canonicalUrl).toBe(
      'https://www.tiktok.com/@fixture.pets/video/7550000000000000001',
    );
    // A provider URL for a different id is not trusted.
    expect(() =>
      canonicalOf({
        ...base.post,
        url: 'https://www.tiktok.com/@x/video/1',
        creatorUsername: null,
      }),
    ).toThrow(/no canonical TikTok URL/);
  });
});

describe('E/F. metrics, publish time, duration', () => {
  it('maps views/likes/comments/shares; missing stays unavailable; explicit zero stays zero', async () => {
    const { adapter, items } = await search();
    const full = safeNormalize(adapter, items[0]!);
    const partial = safeNormalize(adapter, items[1]!);
    if (!full.ok || !partial.ok) throw new Error('fixtures should normalize');
    expect(full.value.metrics).toMatchObject({
      views: { kind: 'value', value: 3_200_000 },
      likes: { kind: 'value', value: 410_000 },
      comments: { kind: 'value', value: 6_100 },
      shares: { kind: 'value', value: 52_000 },
    });
    expect(partial.value.metrics).toMatchObject({
      views: { kind: 'value', value: 41_000 },
      likes: { kind: 'unavailable', reason: 'unknown' }, // digg_count absent → never 0
      comments: { kind: 'value', value: 0 }, // explicit 0 kept
      shares: { kind: 'value', value: 0 }, // "0" (text) kept as 0
    });
    expect(full.value.publishedAt?.toISOString()).toBe('2026-10-03T08:00:00.000Z');
    expect(full.value.durationMs).toBe(18_000);
    expect(partial.value.durationMs).toBe(9_500);
  });
});

describe('L. public metadata only: no media, no private/profile-only data', () => {
  it('drops media URLs, bios, avatars, comments and session tokens at the boundary', async () => {
    const { items, fetch } = await search();
    const stored = JSON.stringify(items.map((i) => i.payload));
    for (const forbidden of [
      'video_url',
      '.mp4',
      '.vtt',
      'fixture@example.com',
      'PRIVATE-ISH BIO',
      'fixture-avatar',
      'DO-NOT-STORE',
      'someone.else',
      'someone.tagged',
    ])
      expect(stored).not.toContain(forbidden);
    // Every request goes to the provider API — never to a TikTok media host.
    expect(new Set(fetch.requests.map((r) => r.url.hostname))).toEqual(
      new Set(['api.brightdata.com']),
    );
  });
});

describe('Bright Data request flow', () => {
  it('triggers a keyword discovery job, polls progress, downloads JSON, and meters requests/records', async () => {
    const { fetch, ctx } = await search(brightdata(), { q: 'funny animals', maxResults: 5 });
    const [trigger, ...rest] = fetch.requests;
    expect(trigger!.method).toBe('POST');
    expect(Object.fromEntries(trigger!.url.searchParams)).toEqual({
      dataset_id: 'gd_lu702nij2f790tmv9h',
      include_errors: 'true',
      type: 'discover_new',
      discover_by: 'keyword',
    });
    expect(JSON.parse(trigger!.body!)).toEqual({
      input: [{ search_keyword: 'funny animals', num_of_posts: 5, country: '' }],
    });
    expect(trigger!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(rest.map((r) => r.url.pathname)).toEqual([
      `/datasets/v3/progress/${SNAP}`,
      `/datasets/v3/progress/${SNAP}`,
      `/datasets/v3/snapshot/${SNAP}`,
    ]);
    // 4 HTTP requests; 3 delivered posts billed (errors/malformed are not posts).
    expect(ctx.quota.usage()).toEqual({ requests: 4, records: 3 });
  });

  it('never asks for (or bills) more records than the local budget allows', async () => {
    const fetch = brightdata();
    const adapter = adapterWith(fetch);
    const ctx = testAdapterContext({ limits: { records: 2 } });
    const items = await collect(
      adapter.discoverSearch!(
        { kind: 'search', params: { q: 'funny', maxResults: 20 }, region: null, limit: 50 },
        ctx,
      ),
    );
    const body = JSON.parse(fetch.requests[0]!.body!) as { input: { num_of_posts: number }[] };
    expect(body.input[0]!.num_of_posts).toBe(2);
    expect(items.filter((i) => (i.payload as { kind: string }).kind === 'post')).toHaveLength(2);
    expect(ctx.quota.usage()['records']).toBe(2);
    const exhausted = testAdapterContext({ limits: { records: 0 } });
    await expect(
      collect(
        adapter.discoverSearch!(
          { kind: 'search', params: { q: 'funny' }, region: null, limit: 50 },
          exhausted,
        ),
      ),
    ).rejects.toBeInstanceOf(QuotaBudgetExhaustedError);
  });
});

describe('H/I/M. failures are explicit and never leak the token', () => {
  it('H: an API failure surfaces as a typed upstream error without the token', async () => {
    const fetch = createFakeFetch([
      route('/datasets/v3/trigger', { status: 401, body: { error: 'Invalid token' } }),
    ]);
    const err = await search(fetch).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).kind).toBe('unauthorized');
    expect((err as Error).message).toMatch(/check BRIGHTDATA_API_TOKEN/);
    expect(JSON.stringify(err) + String(err) + String((err as Error).stack)).not.toContain(TOKEN);
  });

  it('H: a failed or never-ready collection job is an error, bounded in time', async () => {
    const failed = await search(brightdata(snapshot, ['running', 'failed'])).catch(
      (e: unknown) => e,
    );
    expect(String(failed)).toMatch(/collection s_fixture123 failed/);
    let t = 0;
    const slow = createTikTokAdapter({
      provider: createBrightDataProvider({
        token: TOKEN,
        fetch: brightdata(snapshot, ['running']),
        sleep: noSleep,
        maxWaitMs: 30_000,
        pollIntervalMs: 10_000,
        now: () => (t += 10_000),
      }),
    });
    await expect(
      collect(
        slow.discoverSearch!(
          { kind: 'search', params: { q: 'funny' }, region: null, limit: 5 },
          testAdapterContext(),
        ),
      ),
    ).rejects.toThrow(/not ready after 30 s/);
  });

  it('I: a malformed response (no snapshot id / not an array) is invalid_response', async () => {
    const noId = createFakeFetch([route('/datasets/v3/trigger', { body: { ok: true } })]);
    expect(await search(noId).catch((e: unknown) => (e as UpstreamError).kind)).toBe(
      'invalid_response',
    );
    expect(
      await search(brightdata({ not: 'an array' })).catch(
        (e: unknown) => (e as UpstreamError).kind,
      ),
    ).toBe('invalid_response');
  });
});

describe('J/K. lookup and metric refresh', () => {
  const urls = [
    'https://www.tiktok.com/@fixture.pets/video/7550000000000000001',
    'https://www.tiktok.com/@fixture.fails/video/7550000000000000002',
    'https://www.tiktok.com/@gone/video/7550000000000000009',
  ];

  it('looks up known URLs in one provider job, positionally', async () => {
    const fetch = brightdata();
    const adapter = adapterWith(fetch);
    const items = await adapter.lookupUrls!(
      [...urls, 'https://example.com/not-tiktok'],
      testAdapterContext(),
    );
    expect(items.map((i) => i?.externalId ?? null)).toEqual([
      '7550000000000000001',
      '7550000000000000002',
      null,
      null,
    ]);
    const trigger = fetch.requests[0]!;
    expect(trigger.url.searchParams.has('type')).toBe(false); // collect by URL, not discovery
    expect(JSON.parse(trigger.body!)).toEqual({
      input: urls.map((url) => ({ url, country: '' })),
    });
    expect(fetch.requests.filter((r) => r.url.pathname.endsWith('/trigger'))).toHaveLength(1);
  });

  it('refreshes metrics; videos the provider did not return stay unknown, never zero', async () => {
    const adapter = adapterWith(brightdata());
    const results = await adapter.refreshMetrics!(
      urls.map((canonicalUrl) => ({
        canonicalUrl,
        platformVideoId: /video\/(\d+)/.exec(canonicalUrl)![1]!,
      })),
      testAdapterContext({ now: new Date('2026-10-03T14:00:00Z') }),
    );
    expect(checkRefreshResults(adapter, results).every((c) => c.ok)).toBe(true);
    expect(results.map((r) => [r.platformVideoId, r.availability])).toEqual([
      ['7550000000000000001', 'available'],
      ['7550000000000000002', 'available'],
      ['7550000000000000009', 'unknown'],
    ]);
    expect(results[0]!.metrics?.views).toEqual({ kind: 'value', value: 3_200_000 });
    expect(results[2]!.metrics).toBeNull();
  });
});
