import { describe, expect, it } from 'vitest';
import { UpstreamError, safeNormalize, type RawItem } from '@vd/adapter-contract';
import {
  collect,
  createFakeFetch,
  describeAdapterContract,
  route,
  testAdapterContext,
} from '@vd/adapter-contract/testing';
import clips from '../fixtures/clips-by-game.json' with { type: 'json' };
import empty from '../fixtures/clips-empty.json' with { type: 'json' };
import token from '../fixtures/token.json' with { type: 'json' };
import unauthorized from '../fixtures/error-unauthorized.json' with { type: 'json' };
import rateLimited from '../fixtures/error-rate-limited.json' with { type: 'json' };
import { createTwitchAdapter } from './adapter.ts';

const fetchedAt = new Date('2026-09-28T12:00:00Z');
const raw = (payload: unknown, externalId = 'x'): RawItem => ({
  adapterId: 'twitch',
  externalId,
  fetchedAt,
  payload,
  context: {},
});
const [one, two] = clips.data;
const tokenRoute = () => route('/oauth2/token', { body: token });
const make = (fetch = createFakeFetch([])) =>
  createTwitchAdapter({ clientId: 'cid', clientSecret: 'client-secret-value', fetch });

describeAdapterContract('twitch', {
  create: () => make(),
  validFixtures: [raw(one, one!.id), raw(two, two!.id)],
  invalidFixtures: [raw({ id: 'x', broadcaster_id: '1' }, 'no-views'), raw(null, 'null')],
});

describe('twitch normalize', () => {
  it('maps a clip into the common model', () => {
    expect(make().normalize(raw(one))).toMatchObject({
      platform: 'twitch',
      platformVideoId: 'FixtureFunnyClipOne-AbC123dEf456GhI7',
      canonicalUrl: 'https://clips.twitch.tv/FixtureFunnyClipOne-AbC123dEf456GhI7',
      title: 'chat made me do it',
      durationMs: 27_500,
      language: 'en',
      publishedAt: new Date('2026-09-27T21:14:05Z'),
      thumbnailUrl: 'https://static-cdn.jtvnw.net/twitch-clips/fixture-one-preview-480x272.jpg',
      creator: { platformCreatorId: '100000001', displayName: 'FixtureStreamer', profileUrl: null },
      metrics: {
        views: { kind: 'value', value: 18_234 },
        likes: { kind: 'unavailable', reason: 'not_provided_by_platform' },
        shares: { kind: 'unavailable', reason: 'not_provided_by_platform' },
      },
    });
  });

  it('turns empty strings and "other" into explicit nulls', () => {
    expect(make().normalize(raw(two))).toMatchObject({
      title: null,
      thumbnailUrl: null,
      language: null,
      durationMs: 60_000,
    });
  });

  it('rejects malformed clips', () => {
    expect(safeNormalize(make(), raw({ ...one, view_count: -1 })).ok).toBe(false);
    expect(safeNormalize(make(), raw({ ...one, created_at: 'yesterday' })).ok).toBe(false);
  });
});

describe('twitch discovery', () => {
  it('gets an app token once, sends Client-Id + Bearer, and pages with the cursor', async () => {
    const fetch = createFakeFetch([
      tokenRoute(),
      route('/helix/clips', { body: empty }, (u) => u.searchParams.has('after')),
      route('/helix/clips', { body: clips }),
    ]);
    const items = await collect(
      make(fetch).discoverTrending!(
        {
          kind: 'trending',
          params: { gameId: '509658', pages: 3, lookbackHours: 24 },
          region: null,
          limit: 50,
        },
        testAdapterContext(),
      ),
    );
    expect(items.map((i) => i.externalId)).toEqual([one!.id, two!.id]);
    expect(items[0]?.context).toMatchObject({
      gameId: '509658',
      startedAt: '2026-09-27T12:00:00.000Z',
      endedAt: '2026-09-28T12:00:00.000Z',
      rank: 1,
    });

    const [tokenReq, first, second] = fetch.requests;
    expect(tokenReq?.method).toBe('POST');
    expect(tokenReq?.url.search).toBe('');
    expect(tokenReq?.body).toContain('grant_type=client_credentials');
    expect(first?.headers.get('client-id')).toBe('cid');
    expect(first?.headers.get('authorization')).toBe('Bearer fixture-app-token-0001');
    expect(first?.url.searchParams.get('game_id')).toBe('509658');
    expect(first?.url.searchParams.get('started_at')).toBe('2026-09-27T12:00:00.000Z');
    expect(second?.url.searchParams.get('after')).toBe(clips.pagination.cursor);
    expect(fetch.requests.filter((r) => r.url.pathname === '/oauth2/token')).toHaveLength(1);
  });

  it('uses broadcaster_id for channel feeds', async () => {
    const fetch = createFakeFetch([tokenRoute(), route('/helix/clips', { body: empty })]);
    const items = await collect(
      make(fetch).discoverFeed!(
        {
          kind: 'channel_feed',
          params: { broadcasterId: '100000001', first: 5 },
          region: null,
          limit: 50,
        },
        testAdapterContext(),
      ),
    );
    expect(items).toEqual([]);
    expect(fetch.requests[1]?.url.searchParams.get('broadcaster_id')).toBe('100000001');
    expect(fetch.requests[1]?.url.searchParams.get('first')).toBe('5');
  });

  it('validates params before calling the API', async () => {
    const fetch = createFakeFetch([]);
    const run = (params: Record<string, unknown>) =>
      collect(
        make(fetch).discoverTrending!(
          { kind: 'trending', params, region: null, limit: 5 },
          testAdapterContext(),
        ),
      );
    await expect(run({})).rejects.toThrow(/needs params.gameId/);
    await expect(run({ gameId: 'abc' })).rejects.toThrow(/gameId: must be a numeric/);
    await expect(run({ gameId: '1', startedAt: '2026-09-01T00:00:00Z' })).rejects.toThrow(
      /go together/,
    );
    expect(fetch.requests).toHaveLength(0);
  });

  it('refreshes an expired token once on 401', async () => {
    const fetch = createFakeFetch([
      tokenRoute(),
      route('/helix/clips', [{ status: 401, body: unauthorized }, { body: clips }]),
    ]);
    const items = await collect(
      make(fetch).discoverTrending!(
        { kind: 'trending', params: { gameId: '1' }, region: null, limit: 1 },
        testAdapterContext(),
      ),
    );
    expect(items).toHaveLength(1);
    expect(fetch.requests.filter((r) => r.url.pathname === '/oauth2/token')).toHaveLength(2);
  });

  it('reports refused credentials without echoing the secret', async () => {
    const fetch = createFakeFetch([
      route('/oauth2/token', {
        status: 403,
        body: { status: 403, message: 'invalid client secret' },
      }),
    ]);
    const err = await collect(
      make(fetch).discoverTrending!(
        { kind: 'trending', params: { gameId: '1' }, region: null, limit: 1 },
        testAdapterContext(),
      ),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err).toMatchObject({ kind: 'unauthorized' });
    expect((err as Error).message).toMatch(/TWITCH_CLIENT_ID/);
    expect((err as Error).message).not.toContain('client-secret-value');
  });

  it('maps 429 to rate_limited using Ratelimit-Reset', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 42);
    const fetch = createFakeFetch([
      tokenRoute(),
      route('/helix/clips', {
        status: 429,
        body: rateLimited,
        headers: { 'ratelimit-reset': reset },
      }),
    ]);
    const err = await collect(
      make(fetch).discoverTrending!(
        { kind: 'trending', params: { gameId: '1' }, region: null, limit: 1 },
        testAdapterContext(),
      ),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'rate_limited' });
    expect((err as UpstreamError).retryAfterSeconds).toBeGreaterThan(30);
  });
});

describe('twitch lookupUrl and refreshMetrics', () => {
  it('looks up a clip URL by id', async () => {
    const fetch = createFakeFetch([tokenRoute(), route('/helix/clips', { body: { data: [one] } })]);
    const item = await make(fetch).lookupUrl!(
      `https://www.twitch.tv/fixturestreamer/clip/${one!.id}?filter=clips`,
      testAdapterContext(),
    );
    expect(item?.externalId).toBe(one!.id);
    expect(fetch.requests[1]?.url.searchParams.get('id')).toBe(one!.id);
    expect(
      await make(fetch).lookupUrl!('https://youtu.be/dQw4w9WgXcQ', testAdapterContext()),
    ).toBeNull();
  });

  it('refreshes views for up to 100 clips per call', async () => {
    const fetch = createFakeFetch([
      tokenRoute(),
      route('/helix/clips', { body: { data: [{ ...one, view_count: 40_000 }] } }),
    ]);
    const refs = [one!.id, 'GoneClip-xyz'].map((id) => ({
      platformVideoId: id,
      canonicalUrl: `https://clips.twitch.tv/${id}`,
    }));
    const results = await make(fetch).refreshMetrics!(refs, testAdapterContext());
    expect(fetch.requests[1]?.url.searchParams.getAll('id')).toEqual([one!.id, 'GoneClip-xyz']);
    expect(results).toMatchObject([
      {
        platformVideoId: one!.id,
        availability: 'available',
        metrics: { views: { kind: 'value', value: 40_000 } },
      },
      { platformVideoId: 'GoneClip-xyz', availability: 'unknown', metrics: null },
    ]);
  });
});
