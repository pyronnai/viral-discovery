import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UpstreamError, safeNormalize, type RawItem } from '@vd/adapter-contract';
import {
  collect,
  createFakeFetch,
  describeAdapterContract,
  route,
  testAdapterContext,
} from '@vd/adapter-contract/testing';
import search from '../fixtures/searchPosts.json' with { type: 'json' };
import searchEmpty from '../fixtures/searchPosts-empty.json' with { type: 'json' };
import getPosts from '../fixtures/getPosts.json' with { type: 'json' };
import { createBlueskyAdapter } from './adapter.ts';

const forbiddenHtml = readFileSync(
  new URL('../fixtures/error-forbidden.html', import.meta.url),
  'utf8',
);
const SEARCH = '/xrpc/app.bsky.feed.searchPosts';
const [ytPost, videoPost, multiPost, newsPost] = search.posts;

async function discover(
  params: Record<string, unknown>,
  fetch = createFakeFetch([route(SEARCH, { body: search })]),
) {
  const adapter = createBlueskyAdapter({ fetch });
  const items = await collect(
    adapter.discoverSearch!(
      { kind: 'search', params, region: null, limit: 100 },
      testAdapterContext(),
    ),
  );
  return { adapter, items, fetch };
}

const fetchedAt = new Date('2026-09-28T12:00:00Z');
const raw = (payload: unknown, externalId = 'x'): RawItem => ({
  adapterId: 'bluesky',
  externalId,
  fetchedAt,
  payload,
  context: {},
});

describeAdapterContract('bluesky', {
  create: () => createBlueskyAdapter({ fetch: createFakeFetch([]) }),
  validFixtures: [
    raw({ kind: 'native', post: videoPost }, 'native'),
    raw({ kind: 'link', post: ytPost, url: 'https://youtube.com/shorts/vdFixture01' }, 'link-yt'),
    raw(
      {
        kind: 'link',
        post: multiPost,
        url: 'https://clips.twitch.tv/FixtureFunnyClipOne-AbC123dEf456GhI7',
      },
      'link-twitch',
    ),
  ],
  invalidFixtures: [
    raw({ kind: 'native', post: ytPost }, 'native-without-video'),
    raw(
      { kind: 'link', post: newsPost, url: 'https://news.example.com/funny-story' },
      'unsupported-link',
    ),
    raw({ kind: 'native', post: search.posts[4] }, 'malformed'),
  ],
});

describe('bluesky discoverSearch', () => {
  it('emits native videos and resolved links, once per post × video', async () => {
    const { items } = await discover({ q: 'funny' });
    expect(items.map((i) => i.externalId)).toEqual([
      `${ytPost!.uri}#youtube:vdFixture01`, // card + facet link to the same video → one item
      videoPost!.uri,
      `${multiPost!.uri}#tiktok:7412345678901234567`,
      `${multiPost!.uri}#twitch:FixtureFunnyClipOne-AbC123dEf456GhI7`,
      'at://did:plc:fixtureauthor000000000005/app.bsky.feed.post/3fixturepost5', // malformed → quarantine
    ]);
  });

  it('keeps the Bluesky post as sighting context for a linked video', async () => {
    const { items } = await discover({ q: 'funny' });
    expect(items[0]).toMatchObject({
      observationKey: ytPost!.uri,
      context: {
        query: 'funny',
        postUri: ytPost!.uri,
        postUrl: 'https://bsky.app/profile/did:plc:fixtureauthor000000000001/post/3fixturepost1',
        postAuthor: { did: 'did:plc:fixtureauthor000000000001', handle: 'funnyfinds.fixture.test' },
        postCreatedAt: '2026-09-28T09:15:00.000Z',
        postEngagement: { likes: 87, reposts: 12, replies: 3, quotes: 1 },
        linkedUrl: 'https://youtube.com/shorts/vdFixture01?is=trackingParam',
      },
    });
  });

  it('respects include=links and include=native', async () => {
    // Malformed posts are always surfaced (for quarantine), whatever the filter.
    const wellFormed = (items: RawItem[]) => items.filter((i) => 'postUri' in i.context);
    const links = await discover({ q: 'funny', include: 'links' });
    expect(wellFormed(links.items).every((i) => i.externalId.includes('#'))).toBe(true);
    const native = await discover({ q: 'funny', include: 'native' });
    expect(wellFormed(native.items).map((i) => i.externalId)).toEqual([videoPost!.uri]);
  });

  it('passes search filters through and needs no credentials', async () => {
    const { fetch } = await discover({
      q: 'cat',
      sort: 'top',
      domain: 'youtube.com',
      tag: 'funny,pets',
      lang: 'en',
    });
    const url = fetch.requests[0]!.url;
    expect(url.origin).toBe('https://api.bsky.app');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      q: 'cat',
      sort: 'top',
      domain: 'youtube.com',
      lang: 'en',
      limit: '25',
    });
    expect(url.searchParams.getAll('tag')).toEqual(['funny', 'pets']);
    expect(fetch.requests[0]!.headers.has('authorization')).toBe(false);
  });

  it('requires a query', async () => {
    await expect(discover({})).rejects.toThrow(/q:/);
  });

  it('returns nothing for empty results', async () => {
    const { items } = await discover(
      { q: 'nothing' },
      createFakeFetch([route(SEARCH, { body: searchEmpty })]),
    );
    expect(items).toEqual([]);
  });

  it('explains a 403 from a host that does not serve unauthenticated search', async () => {
    const err = await discover(
      { q: 'x' },
      createFakeFetch([route(SEARCH, { status: 403, body: forbiddenHtml })]),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err).toMatchObject({ kind: 'forbidden', status: 403 });
    expect((err as Error).message).toMatch(/may require authentication/);
  });
});

describe('bluesky normalize', () => {
  const adapter = createBlueskyAdapter({ fetch: createFakeFetch([]) });

  it('normalizes a linked YouTube video as a YouTube reference, not a Bluesky video', () => {
    const video = adapter.normalize(
      raw({ kind: 'link', post: ytPost, url: 'https://youtube.com/shorts/vdFixture01?is=x' }),
    );
    expect(video).toEqual({
      platform: 'youtube',
      platformVideoId: 'vdFixture01',
      canonicalUrl: 'https://www.youtube.com/watch?v=vdFixture01',
      creator: null,
      title: 'cat vs vacuum 😂 - YouTube', // link-card title: fills an empty title only
      caption: null,
      publishedAt: null,
      durationMs: null,
      thumbnailUrl: null,
      language: null,
      contentOrigin: 'discovered_external',
      availability: 'unknown',
      metrics: null,
      observedAt: fetchedAt,
    });
  });

  it('does not borrow the link card title for a different linked video', () => {
    const video = adapter.normalize(
      raw({
        kind: 'link',
        post: multiPost,
        url: 'https://clips.twitch.tv/FixtureFunnyClipOne-AbC123dEf456GhI7',
      }),
    );
    expect(video).toMatchObject({ platform: 'twitch', title: null, metrics: null });
  });

  it('normalizes a native Bluesky video with post metrics', () => {
    const video = adapter.normalize(raw({ kind: 'native', post: videoPost }));
    expect(video).toMatchObject({
      platform: 'bluesky',
      platformVideoId: videoPost!.uri,
      canonicalUrl: 'https://bsky.app/profile/did:plc:fixtureauthor000000000002/post/3fixturepost2',
      creator: {
        platformCreatorId: 'did:plc:fixtureauthor000000000002',
        handle: 'dogclips.fixture.test',
        displayName: null,
      },
      caption: 'my dog trying to catch snow 😂',
      durationMs: null,
      thumbnailUrl: expect.stringMatching(/thumbnail\.jpg$/) as unknown,
      metrics: {
        likes: { kind: 'value', value: 512 },
        comments: { kind: 'value', value: 9 },
        views: { kind: 'unavailable', reason: 'not_provided_by_platform' },
        shares: { kind: 'unavailable', reason: 'not_provided_by_platform' },
      },
    });
    // The playlist is a media URL; it is never stored.
    expect(JSON.stringify(video)).not.toContain('playlist');
  });

  it('refuses metrics on references at the contract boundary', () => {
    const cheating = {
      ...adapter,
      normalize: (r: RawItem) => ({
        ...adapter.normalize(r),
        metrics: adapter.normalize(raw({ kind: 'native', post: videoPost })).metrics,
      }),
    };
    const result = safeNormalize(
      cheating,
      raw({ kind: 'link', post: ytPost, url: 'https://youtu.be/vdFixture01' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toMatch(/must not carry metrics/);
  });
});

describe('bluesky refreshMetrics', () => {
  it('re-reads native video posts in batches of 25 via getPosts', async () => {
    const fetch = createFakeFetch([route('/xrpc/app.bsky.feed.getPosts', { body: getPosts })]);
    const adapter = createBlueskyAdapter({ fetch });
    const refs = [videoPost!.uri, 'at://did:plc:gone/app.bsky.feed.post/deleted'].map((uri) => ({
      platformVideoId: uri,
      canonicalUrl: 'https://bsky.app/x',
    }));
    const results = await adapter.refreshMetrics!(refs, testAdapterContext());
    expect(fetch.requests[0]!.url.searchParams.getAll('uris')).toEqual(
      refs.map((r) => r.platformVideoId),
    );
    expect(results).toMatchObject([
      {
        availability: 'available',
        metrics: { likes: { kind: 'value', value: 2048 }, comments: { kind: 'value', value: 31 } },
      },
      { availability: 'unknown', metrics: null },
    ]);
  });
});

describe('bluesky TikTok short links', () => {
  const shortPost = {
    ...multiPost!,
    uri: 'at://did:plc:fixtureauthor000000000006/app.bsky.feed.post/3fixturepost6',
    embed: {
      $type: 'app.bsky.embed.external#view',
      external: { uri: 'https://www.tiktok.com/t/ZTshort1/', title: 'TikTok', description: '' },
    },
    record: { ...multiPost!.record, facets: [] },
  };
  const brokenPost = {
    ...shortPost,
    uri: 'at://did:plc:fixtureauthor000000000007/app.bsky.feed.post/3fixturepost7',
    embed: {
      $type: 'app.bsky.embed.external#view',
      external: { uri: 'https://vm.tiktok.com/ZMbroken/', title: 'TikTok', description: '' },
    },
  };
  const video = 'https://www.tiktok.com/@fixture.creator/video/7412345678901234567?_r=1&_t=x';

  it('expands short links once per run and quarantines failures instead of dropping them', async () => {
    const fetch = createFakeFetch([
      route(SEARCH, {
        body: {
          posts: [
            shortPost,
            { ...shortPost, uri: shortPost.uri.replace('post6', 'post8') },
            brokenPost,
          ],
        },
      }),
      {
        match: (u) => u.href === 'https://www.tiktok.com/t/ZTshort1/',
        responses: [{ status: 301, body: '', headers: { location: video } }],
      },
      {
        match: (u) => u.hostname === 'vm.tiktok.com',
        responses: [
          { status: 302, body: '', headers: { location: 'https://www.tiktok.com/?_r=1' } },
        ],
      },
    ]);
    const adapter = createBlueskyAdapter({ fetch });
    const ctx = testAdapterContext();
    const items = await collect(
      adapter.discoverSearch!({ kind: 'search', params: { q: 'x' }, region: null, limit: 10 }, ctx),
    );

    expect(items.map((i) => i.externalId)).toEqual([
      `${shortPost.uri}#tiktok:7412345678901234567`,
      `${shortPost.uri.replace('post6', 'post8')}#tiktok:7412345678901234567`,
      `${brokenPost.uri}#unresolved:https://vm.tiktok.com/ZMbroken/`,
    ]);
    // The same short link in two posts is expanded once.
    expect(fetch.requests.filter((r) => r.url.pathname === '/t/ZTshort1/')).toHaveLength(1);
    expect(ctx.quota.usage()).toMatchObject({ 'tiktok-shortlink': 2 });

    expect(adapter.normalize(items[0]!)).toMatchObject({
      platform: 'tiktok',
      platformVideoId: '7412345678901234567',
      canonicalUrl: 'https://www.tiktok.com/@fixture.creator/video/7412345678901234567',
      metrics: null,
    });
    expect(items[0]!.context).toMatchObject({ linkedUrl: 'https://www.tiktok.com/t/ZTshort1/' });
    const broken = safeNormalize(adapter, items[2]!);
    expect(!broken.ok && broken.errors.join()).toMatch(/short link not resolved: not_a_video/);
  });

  it('can be disabled', async () => {
    const fetch = createFakeFetch([route(SEARCH, { body: { posts: [shortPost] } })]);
    const items = await collect(
      createBlueskyAdapter({ fetch, expandShortLinks: false }).discoverSearch!(
        { kind: 'search', params: { q: 'x' }, region: null, limit: 10 },
        testAdapterContext(),
      ),
    );
    expect(items).toEqual([]);
    expect(fetch.requests).toHaveLength(1);
  });
});
