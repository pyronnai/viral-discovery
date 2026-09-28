import { describe, expect, it } from 'vitest';
import {
  QuotaBudgetExhaustedError,
  UpstreamError,
  checkRefreshResults,
  safeNormalize,
  type RawItem,
} from '@vd/adapter-contract';
import {
  collect,
  createFakeFetch,
  describeAdapterContract,
  route,
  testAdapterContext,
} from '@vd/adapter-contract/testing';
import mostPopular from '../fixtures/videos-list-mostPopular.json' with { type: 'json' };
import page2 from '../fixtures/videos-list-page2.json' with { type: 'json' };
import empty from '../fixtures/videos-list-empty.json' with { type: 'json' };
import batchStats from '../fixtures/batchGetStats.json' with { type: 'json' };
import quotaError from '../fixtures/error-quota-exceeded.json' with { type: 'json' };
import { createYouTubeAdapter } from './adapter.ts';
import { parseIsoDurationMs } from './duration.ts';

const fetchedAt = new Date('2026-09-28T12:00:00Z');
const raw = (payload: unknown, externalId = 'x'): RawItem => ({
  adapterId: 'youtube',
  externalId,
  fetchedAt,
  payload,
  context: {},
});
const [cat, kitchen, malformed] = mostPopular.items;

describeAdapterContract('youtube', {
  create: () => createYouTubeAdapter({ apiKey: 'test-key', fetch: createFakeFetch([]) }),
  validFixtures: [raw(cat, 'vdFixture01'), raw(kitchen, 'vdFixture02'), raw(page2.items[0])],
  invalidFixtures: [raw(malformed, 'vdFixture03'), raw({ id: 'x', snippet: {} }, 'no-channel')],
});

describe('youtube normalize', () => {
  const adapter = createYouTubeAdapter({ apiKey: 'k', fetch: createFakeFetch([]) });

  it('maps the video resource into the common model', () => {
    const video = adapter.normalize(raw(cat));
    expect(video).toMatchObject({
      platform: 'youtube',
      platformVideoId: 'vdFixture01',
      canonicalUrl: 'https://www.youtube.com/watch?v=vdFixture01',
      title: 'Cat discovers the vacuum cleaner',
      durationMs: 42_000,
      language: 'en',
      thumbnailUrl: 'https://i.ytimg.com/vi/vdFixture01/hqdefault.jpg',
      publishedAt: new Date('2026-09-27T14:03:11Z'),
      observedAt: fetchedAt,
      creator: {
        platformCreatorId: 'UCvdFixtureChannel000001',
        displayName: 'Fixture Pets',
        profileUrl: 'https://www.youtube.com/channel/UCvdFixtureChannel000001',
      },
    });
    expect(video.metrics).toMatchObject({
      views: { kind: 'value', value: 50_000 },
      likes: { kind: 'value', value: 4_200 },
      comments: { kind: 'value', value: 310 },
      shares: { kind: 'unavailable', reason: 'not_provided_by_platform' },
    });
  });

  it('keeps missing counts explicit instead of guessing', () => {
    const video = adapter.normalize(raw(kitchen));
    expect(video.metrics?.likes).toEqual({ kind: 'unavailable', reason: 'unknown' });
    expect(video.metrics?.comments).toEqual({ kind: 'unavailable', reason: 'unknown' });
    expect(video.metrics?.views).toEqual({ kind: 'value', value: 910_000 });
    expect(video.caption).toBeNull();
    expect(video.thumbnailUrl).toBe('https://i.ytimg.com/vi/vdFixture02/maxresdefault.jpg');
  });

  it('does not report a duration for live broadcasts', () => {
    const live = { ...cat, snippet: { ...cat!.snippet, liveBroadcastContent: 'live' } };
    expect(adapter.normalize(raw(live)).durationMs).toBeNull();
  });

  it('quarantines malformed items instead of crashing', () => {
    const result = safeNormalize(adapter, raw(malformed));
    expect(result.ok).toBe(false);
  });
});

describe('parseIsoDurationMs', () => {
  it.each([
    ['PT42S', 42_000],
    ['PT1M', 60_000],
    ['PT15M33S', 933_000],
    ['PT1H2M3S', 3_723_000],
    ['P1DT2H', 93_600_000],
    ['P0D', 0],
    ['PT1.5S', 1_500],
  ])('%s → %d', (input, ms) => {
    expect(parseIsoDurationMs(input)).toBe(ms);
  });
  it.each([undefined, '', 'P', 'PT', '42', 'PT4X'])('%j → null', (input) => {
    expect(parseIsoDurationMs(input)).toBeNull();
  });
});

describe('youtube discoverTrending', () => {
  const videos = '/youtube/v3/videos';

  it('queries every region × category chart with the key in a header, never the URL', async () => {
    const fetch = createFakeFetch([route(videos, { body: empty })]);
    const adapter = createYouTubeAdapter({ apiKey: 'secret-key', fetch });
    await collect(
      adapter.discoverTrending!(
        {
          kind: 'trending',
          params: { regionCode: 'us, gb', videoCategoryId: ['23', '15'] },
          region: null,
          limit: 100,
        },
        testAdapterContext(),
      ),
    );
    const combos = fetch.requests.map(
      (r) => `${r.url.searchParams.get('regionCode')}/${r.url.searchParams.get('videoCategoryId')}`,
    );
    expect(combos).toEqual(['US/23', 'US/15', 'GB/23', 'GB/15']);
    for (const r of fetch.requests) {
      expect(r.url.searchParams.get('chart')).toBe('mostPopular');
      expect(r.url.searchParams.get('maxResults')).toBe('50');
      expect(r.url.href).not.toContain('secret-key');
      expect(r.headers.get('x-goog-api-key')).toBe('secret-key');
    }
  });

  it('yields every item (including malformed ones) with chart context, following pages', async () => {
    const fetch = createFakeFetch([
      route(videos, { body: page2 }, (u) => u.searchParams.get('pageToken') === 'CAIQAA'),
      route(videos, { body: mostPopular }),
    ]);
    const adapter = createYouTubeAdapter({ apiKey: 'k', fetch });
    const items = await collect(
      adapter.discoverTrending!(
        { kind: 'trending', params: { regionCode: 'US', pages: 2 }, region: null, limit: 100 },
        testAdapterContext(),
      ),
    );
    expect(items.map((i) => i.externalId)).toEqual([
      'vdFixture01',
      'vdFixture02',
      'vdFixture03',
      'vdFixture04',
    ]);
    expect(items[3]).toMatchObject({
      context: { chart: 'mostPopular', regionCode: 'US', videoCategoryId: null, rank: 4 },
      observationKey: 'mostPopular:US:all',
    });
    expect(fetch.requests).toHaveLength(2);
  });

  it('falls back to the query region, and requires one', async () => {
    const fetch = createFakeFetch([route(videos, { body: empty })]);
    const adapter = createYouTubeAdapter({ apiKey: 'k', fetch });
    await collect(
      adapter.discoverTrending!(
        { kind: 'trending', params: {}, region: 'de', limit: 5 },
        testAdapterContext(),
      ),
    );
    expect(fetch.requests[0]?.url.searchParams.get('regionCode')).toBe('DE');
    await expect(
      collect(
        adapter.discoverTrending!(
          { kind: 'trending', params: {}, region: null, limit: 5 },
          testAdapterContext(),
        ),
      ),
    ).rejects.toThrow(/at least one region/);
  });

  it('rejects invalid params with a message naming the parameter', async () => {
    const adapter = createYouTubeAdapter({ apiKey: 'k', fetch: createFakeFetch([]) });
    await expect(
      collect(
        adapter.discoverTrending!(
          {
            kind: 'trending',
            params: { regionCode: 'USA', maxResults: 500 },
            region: null,
            limit: 5,
          },
          testAdapterContext(),
        ),
      ),
    ).rejects.toThrow(/regionCode.*alpha-2.*maxResults/s);
  });

  it('returns nothing for an empty chart', async () => {
    const adapter = createYouTubeAdapter({
      apiKey: 'k',
      fetch: createFakeFetch([route(videos, { body: empty })]),
    });
    const items = await collect(
      adapter.discoverTrending!(
        { kind: 'trending', params: { regionCode: 'US' }, region: null, limit: 5 },
        testAdapterContext(),
      ),
    );
    expect(items).toEqual([]);
  });

  it('maps quotaExceeded to a typed error without leaking the key', async () => {
    const adapter = createYouTubeAdapter({
      apiKey: 'secret-key',
      fetch: createFakeFetch([route(videos, { status: 403, body: quotaError })]),
    });
    const err = await collect(
      adapter.discoverTrending!(
        { kind: 'trending', params: { regionCode: 'US' }, region: null, limit: 5 },
        testAdapterContext(),
      ),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err).toMatchObject({ kind: 'quota_exceeded', status: 403 });
    expect((err as Error).message).not.toContain('secret-key');
  });

  it('maps 429 to rate_limited with Retry-After', async () => {
    const adapter = createYouTubeAdapter({
      apiKey: 'k',
      fetch: createFakeFetch([
        route(videos, { status: 429, body: {}, headers: { 'retry-after': '30' } }),
      ]),
    });
    const err = await collect(
      adapter.discoverTrending!(
        { kind: 'trending', params: { regionCode: 'US' }, region: null, limit: 5 },
        testAdapterContext(),
      ),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 30 });
  });

  it('stops before calling the API when the local budget is spent', async () => {
    const fetch = createFakeFetch([route(videos, { body: mostPopular })]);
    const adapter = createYouTubeAdapter({ apiKey: 'k', fetch });
    await expect(
      collect(
        adapter.discoverTrending!(
          { kind: 'trending', params: { regionCode: 'US' }, region: null, limit: 5 },
          testAdapterContext({ limits: { default: 0 } }),
        ),
      ),
    ).rejects.toBeInstanceOf(QuotaBudgetExhaustedError);
    expect(fetch.requests).toHaveLength(0);
  });
});

describe('youtube lookupUrl', () => {
  it('resolves any YouTube URL form to one videos.list?id= call', async () => {
    const fetch = createFakeFetch([
      route(
        '/youtube/v3/videos',
        { body: { items: [cat] } },
        (u) => u.searchParams.get('id') === 'vdFixture01',
      ),
    ]);
    const adapter = createYouTubeAdapter({ apiKey: 'k', fetch });
    const item = await adapter.lookupUrl!(
      'https://youtube.com/shorts/vdFixture01?si=x',
      testAdapterContext(),
    );
    expect(item).toMatchObject({ externalId: 'vdFixture01', context: { urlKind: 'short' } });
  });

  it('returns null for other platforms and for videos the API does not return', async () => {
    const fetch = createFakeFetch([route('/youtube/v3/videos', { body: empty })]);
    const adapter = createYouTubeAdapter({ apiKey: 'k', fetch });
    expect(
      await adapter.lookupUrl!('https://clips.twitch.tv/SomeClip', testAdapterContext()),
    ).toBeNull();
    expect(
      await adapter.lookupUrl!('https://youtu.be/vdFixture99', testAdapterContext()),
    ).toBeNull();
    expect(fetch.requests).toHaveLength(1);
  });
});

describe('youtube refreshMetrics (videos:batchGetStats)', () => {
  it('refreshes in one call and marks unreturned videos as unknown', async () => {
    const fetch = createFakeFetch([
      route('/youtube/v3/videos:batchGetStats', { body: batchStats }),
    ]);
    const adapter = createYouTubeAdapter({ apiKey: 'k', fetch });
    const ctx = testAdapterContext({ now: new Date('2026-09-28T18:00:00Z') });
    const refs = ['vdFixture01', 'vdFixture02', 'vdFixture09'].map((id) => ({
      platformVideoId: id,
      canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
    }));
    const results = await adapter.refreshMetrics!(refs, ctx);

    expect(fetch.requests).toHaveLength(1);
    expect(fetch.requests[0]?.url.searchParams.get('id')).toBe(
      'vdFixture01,vdFixture02,vdFixture09',
    );
    expect(ctx.quota.usage()).toEqual({ 'videos.batchGetStats': 1 });
    expect(results[0]).toMatchObject({
      platformVideoId: 'vdFixture01',
      availability: 'available',
      metrics: { views: { kind: 'value', value: 110_000 }, likes: { kind: 'value', value: 9_100 } },
    });
    expect(results[1]?.metrics?.likes).toEqual({ kind: 'unavailable', reason: 'unknown' });
    expect(results[2]).toMatchObject({
      platformVideoId: 'vdFixture09',
      availability: 'unknown',
      metrics: null,
    });
    expect(checkRefreshResults(adapter, results).every((r) => r.ok)).toBe(true);
  });

  it('chunks large refreshes', async () => {
    const fetch = createFakeFetch([
      route('/youtube/v3/videos:batchGetStats', { body: { items: [] } }),
    ]);
    const adapter = createYouTubeAdapter({ apiKey: 'k', fetch });
    const refs = Array.from({ length: 120 }, (_, i) => ({
      platformVideoId: `id${String(i).padStart(9, '0')}`,
      canonicalUrl: 'https://www.youtube.com/watch?v=x',
    }));
    const results = await adapter.refreshMetrics!(refs, testAdapterContext());
    expect(fetch.requests.map((r) => r.url.searchParams.get('id')?.split(',').length)).toEqual([
      50, 50, 20,
    ]);
    expect(results).toHaveLength(120);
  });
});
