import { describe, expect, it } from 'vitest';
import { UpstreamError, safeNormalize, type RawItem } from '@vd/adapter-contract';
import {
  createFakeFetch,
  describeAdapterContract,
  route,
  testAdapterContext,
} from '@vd/adapter-contract/testing';
import oembed from '../fixtures/tiktok-oembed.json' with { type: 'json' };
import oembedError from '../fixtures/tiktok-oembed-error.json' with { type: 'json' };
import { createManualUrlAdapter } from './adapter.ts';

const TIKTOK = 'https://www.tiktok.com/@fixture.creator/video/7412345678901234567?is_from_webapp=1';
const fetchedAt = new Date('2026-09-28T12:00:00Z');
const raw = (payload: unknown, externalId = 'x'): RawItem => ({
  adapterId: 'manual-url',
  externalId,
  fetchedAt,
  payload,
  context: {},
});

describeAdapterContract('manual-url', {
  create: () => createManualUrlAdapter({ fetch: createFakeFetch([]) }),
  validFixtures: [
    raw({ submittedUrl: TIKTOK, oembed }, 'tiktok'),
    raw({ submittedUrl: 'https://youtu.be/dQw4w9WgXcQ', oembed: null }, 'youtube'),
    raw({ submittedUrl: 'https://clips.twitch.tv/SomeClip-abc', oembed: null }, 'twitch'),
  ],
  invalidFixtures: [
    raw({ submittedUrl: 'https://vimeo.com/1', oembed: null }, 'vimeo'),
    raw({ submittedUrl: TIKTOK }, 'missing-oembed-key'),
  ],
});

describe('manual-url lookupUrl', () => {
  it('enriches TikTok URLs through the official oEmbed endpoint, without credentials', async () => {
    const fetch = createFakeFetch([route('/oembed', { body: oembed })]);
    const adapter = createManualUrlAdapter({ fetch });
    const item = await adapter.lookupUrl!(TIKTOK, testAdapterContext());

    const request = fetch.requests[0]!;
    expect(request.url.origin + request.url.pathname).toBe('https://www.tiktok.com/oembed');
    expect(request.url.searchParams.get('url')).toBe(
      'https://www.tiktok.com/@fixture.creator/video/7412345678901234567',
    );
    expect(request.headers.has('authorization')).toBe(false);
    expect(item).toMatchObject({
      externalId: 'tiktok:7412345678901234567',
      context: { submittedUrl: TIKTOK },
    });
  });

  it('normalizes only what oEmbed provides; metrics stay unavailable', async () => {
    const adapter = createManualUrlAdapter({
      fetch: createFakeFetch([route('/oembed', { body: oembed })]),
    });
    const result = safeNormalize(
      adapter,
      (await adapter.lookupUrl!(TIKTOK, testAdapterContext()))!,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        platform: 'tiktok',
        platformVideoId: '7412345678901234567',
        canonicalUrl: 'https://www.tiktok.com/@fixture.creator/video/7412345678901234567',
        creator: {
          platform: 'tiktok',
          platformCreatorId: null,
          handle: 'fixture.creator',
          displayName: 'Fixture Creator',
          profileUrl: 'https://www.tiktok.com/@fixture.creator',
          followerCount: null,
        },
        title: 'when the cat hears the treat bag #funny #cat',
        caption: null,
        publishedAt: null,
        durationMs: null,
        thumbnailUrl: oembed.thumbnail_url,
        language: null,
        contentOrigin: 'discovered_external',
        availability: 'available',
        metrics: null,
        observedAt: new Date('2026-09-28T12:00:00Z'),
      },
    });
  });

  it('records YouTube and Twitch URLs by identity without any network call', async () => {
    const fetch = createFakeFetch([]);
    const adapter = createManualUrlAdapter({ fetch });
    const yt = await adapter.lookupUrl!(
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      testAdapterContext(),
    );
    const tw = await adapter.lookupUrl!(
      'https://www.twitch.tv/chan/clip/SomeClip-abc',
      testAdapterContext(),
    );
    expect(fetch.requests).toHaveLength(0);
    expect(adapter.normalize(yt!)).toMatchObject({
      platform: 'youtube',
      platformVideoId: 'dQw4w9WgXcQ',
      canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      availability: 'unknown',
      creator: null,
      metrics: null,
    });
    expect(adapter.normalize(tw!)).toMatchObject({
      platform: 'twitch',
      platformVideoId: 'SomeClip-abc',
    });
  });

  it('returns null for unsupported URLs', async () => {
    const adapter = createManualUrlAdapter({ fetch: createFakeFetch([]) });
    for (const url of [
      'https://vimeo.com/1',
      'https://www.tiktok.com/@x/photo/7412345678901234567',
      'not a url',
    ]) {
      expect(await adapter.lookupUrl!(url, testAdapterContext())).toBeNull();
    }
  });

  it('expands a TikTok short link (allowlisted HEAD redirect) and then uses oEmbed', async () => {
    const fetch = createFakeFetch([
      {
        match: (u, method) => u.href === 'https://www.tiktok.com/t/ZTshort1/' && method === 'HEAD',
        responses: [{ status: 301, body: '', headers: { location: TIKTOK } }],
      },
      route('/oembed', { body: oembed }),
    ]);
    const adapter = createManualUrlAdapter({ fetch });
    const ctx = testAdapterContext();
    const item = await adapter.lookupUrl!('https://www.tiktok.com/t/ZTshort1/', ctx);
    expect(item).toMatchObject({
      externalId: 'tiktok:7412345678901234567',
      context: {
        expandedFrom: 'https://www.tiktok.com/t/ZTshort1/',
        expandedTo: 'https://www.tiktok.com/@fixture.creator/video/7412345678901234567',
      },
    });
    expect(fetch.requests[1]?.url.searchParams.get('url')).toBe(
      'https://www.tiktok.com/@fixture.creator/video/7412345678901234567',
    );
    expect(ctx.quota.usage()).toEqual({ 'tiktok-shortlink': 1, 'tiktok-oembed': 1 });
    expect(adapter.normalize(item!)).toMatchObject({
      platform: 'tiktok',
      platformVideoId: '7412345678901234567',
    });
  });

  it('fails with a reason when a short link redirects somewhere unexpected', async () => {
    const fetch = createFakeFetch([
      {
        match: (u) => u.hostname === 'vm.tiktok.com',
        responses: [
          { status: 302, body: '', headers: { location: 'https://evil.example/@x/video/1234567' } },
        ],
      },
    ]);
    const err = await createManualUrlAdapter({ fetch }).lookupUrl!(
      'https://vm.tiktok.com/ZMabc/',
      testAdapterContext(),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as Error).message).toMatch(/unexpected_host/);
    expect(fetch.requests).toHaveLength(1);
  });

  it('fails cleanly when TikTok returns no embed', async () => {
    const adapter = createManualUrlAdapter({
      fetch: createFakeFetch([route('/oembed', { status: 400, body: oembedError })]),
    });
    const err = await adapter.lookupUrl!(TIKTOK, testAdapterContext()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err).toMatchObject({ kind: 'not_found' });
    expect((err as Error).message).toMatch(/private, removed/);
  });
});
