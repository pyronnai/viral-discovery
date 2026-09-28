import { describe, expect, it } from 'vitest';
import { expandTikTokShortLink, isTikTokShortLink, type FetchLike } from './tiktok-short-links.ts';
import { resolveVideoUrlWithExpansion } from './index.ts';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** Scripted responses keyed by exact URL; records every request. */
function scripted(map: Record<string, { status: number; location?: string } | 'hang' | 'throw'>) {
  const calls: Call[] = [];
  const fetch: FetchLike = (input, init) => {
    const url = new URL(input).href;
    calls.push({ url, init });
    const entry = map[url];
    if (entry === undefined) return Promise.reject(new Error(`unexpected request to ${url}`));
    if (entry === 'throw') return Promise.reject(new TypeError('fetch failed'));
    if (entry === 'hang') {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason instanceof Error ? init.signal.reason : new Error('aborted'));
        });
      });
    }
    const headers: Record<string, string> =
      entry.location === undefined ? {} : { location: entry.location };
    return Promise.resolve(new Response(null, { status: entry.status, headers }));
  };
  return { fetch, calls };
}

const SHORT = 'https://www.tiktok.com/t/ZTyUGaVNb/';
const VIDEO =
  'https://www.tiktok.com/@fixture.user/video/7375040130798587154?_r=1&_t=ZT-9A7SbBoFD1J';

describe('expandTikTokShortLink', () => {
  it('expands a /t/ link with one HEAD request and never requests the video page', async () => {
    const { fetch, calls } = scripted({ [SHORT]: { status: 301, location: VIDEO } });
    const result = await expandTikTokShortLink(SHORT, { fetch });
    expect(result).toEqual({
      ok: true,
      resolved: {
        ok: true,
        platform: 'tiktok',
        platformVideoId: '7375040130798587154',
        canonicalUrl: 'https://www.tiktok.com/@fixture.user/video/7375040130798587154',
        kind: 'video',
      },
      hops: [
        'https://www.tiktok.com/t/ZTyUGaVNb/',
        'https://www.tiktok.com/@fixture.user/video/7375040130798587154',
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init).toMatchObject({
      method: 'HEAD',
      redirect: 'manual',
      credentials: 'omit',
    });
  });

  it('follows a bounded chain across allowlisted TikTok hosts (vm → /t/ → video)', async () => {
    const { fetch, calls } = scripted({
      'https://vm.tiktok.com/ZMabc123/': {
        status: 302,
        location: 'https://www.tiktok.com/t/ZTnext/',
      },
      'https://www.tiktok.com/t/ZTnext/': { status: 301, location: VIDEO },
    });
    const result = await expandTikTokShortLink('vm.tiktok.com/ZMabc123/', { fetch });
    expect(result.ok && result.resolved.platformVideoId).toBe('7375040130798587154');
    expect(calls.map((c) => c.url)).toEqual([
      'https://vm.tiktok.com/ZMabc123/',
      'https://www.tiktok.com/t/ZTnext/',
    ]);
  });

  it('resolves relative Location headers against the current URL', async () => {
    const { fetch } = scripted({
      [SHORT]: { status: 301, location: '/@fixture.user/video/7375040130798587154' },
    });
    const result = await expandTikTokShortLink(SHORT, { fetch });
    expect(result.ok).toBe(true);
  });

  it.each([
    ['another domain', 'https://evil.example/@x/video/123456789'],
    ['a lookalike domain', 'https://www.tiktok.com.evil.example/@x/video/123456789'],
    ['plain http', 'http://www.tiktok.com/@x/video/7375040130798587154'],
    ['a non-default port', 'https://www.tiktok.com:8443/@x/video/7375040130798587154'],
    ['embedded credentials', 'https://user:pw@www.tiktok.com/@x/video/7375040130798587154'],
    ['an internal address', 'https://169.254.169.254/latest/meta-data/'],
    ['localhost', 'https://localhost/t/abc/'],
  ])('rejects a redirect to %s without requesting it', async (_label, location) => {
    const { fetch, calls } = scripted({ [SHORT]: { status: 302, location } });
    const result = await expandTikTokShortLink(SHORT, { fetch });
    expect(result).toMatchObject({ ok: false, reason: 'unexpected_host' });
    expect(calls).toHaveLength(1);
  });

  it('detects redirect loops', async () => {
    const { fetch } = scripted({
      'https://vm.tiktok.com/ZMa/': { status: 302, location: 'https://vt.tiktok.com/ZSb/' },
      'https://vt.tiktok.com/ZSb/': { status: 302, location: 'https://vm.tiktok.com/ZMa/' },
    });
    expect(await expandTikTokShortLink('https://vm.tiktok.com/ZMa/', { fetch })).toMatchObject({
      ok: false,
      reason: 'redirect_loop',
    });
  });

  it('stops after too many redirects', async () => {
    const { fetch, calls } = scripted({
      'https://vm.tiktok.com/Z1/': { status: 302, location: 'https://vm.tiktok.com/Z2/' },
      'https://vm.tiktok.com/Z2/': { status: 302, location: 'https://vm.tiktok.com/Z3/' },
      'https://vm.tiktok.com/Z3/': { status: 302, location: 'https://vm.tiktok.com/Z4/' },
    });
    const result = await expandTikTokShortLink('https://vm.tiktok.com/Z1/', {
      fetch,
      maxRedirects: 2,
    });
    expect(result).toMatchObject({ ok: false, reason: 'too_many_redirects' });
    expect(calls).toHaveLength(2);
  });

  it.each([
    ['no Location header', { status: 301 }],
    ['an unparseable Location header', { status: 301, location: 'https://[not-a-host' }],
  ])('rejects %s', async (_label, entry) => {
    const { fetch } = scripted({ [SHORT]: entry });
    expect(await expandTikTokShortLink(SHORT, { fetch })).toMatchObject({
      ok: false,
      reason: 'bad_location',
    });
  });

  it('rejects a redirect to a non-video page (e.g. an invalid code → homepage)', async () => {
    const { fetch } = scripted({
      'https://vm.tiktok.com/ZMbad/': { status: 302, location: 'https://www.tiktok.com/?_r=1' },
    });
    expect(await expandTikTokShortLink('https://vm.tiktok.com/ZMbad/', { fetch })).toMatchObject({
      ok: false,
      reason: 'not_a_video',
    });
  });

  it('reports non-redirect responses', async () => {
    expect(
      await expandTikTokShortLink(SHORT, scripted({ [SHORT]: { status: 200 } })),
    ).toMatchObject({ reason: 'no_redirect' });
    expect(
      await expandTikTokShortLink(SHORT, scripted({ [SHORT]: { status: 404 } })),
    ).toMatchObject({ reason: 'http_error' });
  });

  it('reports network failures and timeouts', async () => {
    expect(await expandTikTokShortLink(SHORT, scripted({ [SHORT]: 'throw' }))).toMatchObject({
      ok: false,
      reason: 'network',
    });
    const hung = await expandTikTokShortLink(SHORT, {
      ...scripted({ [SHORT]: 'hang' }),
      timeoutMs: 20,
    });
    expect(hung).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('refuses to request anything that is not a recognized short link', async () => {
    const { fetch, calls } = scripted({});
    for (const input of [
      'https://evil.example/t/abc/',
      VIDEO,
      'https://youtu.be/dQw4w9WgXcQ',
      'nonsense',
    ]) {
      expect(await expandTikTokShortLink(input, { fetch })).toMatchObject({
        ok: false,
        reason: 'not_short_link',
      });
    }
    expect(calls).toHaveLength(0);
  });

  it('upgrades an http short link to https before requesting it', async () => {
    const { fetch, calls } = scripted({ [SHORT]: { status: 301, location: VIDEO } });
    await expandTikTokShortLink('http://www.tiktok.com/t/ZTyUGaVNb/', { fetch });
    expect(calls[0]?.url).toBe(SHORT);
  });
});

describe('resolveVideoUrlWithExpansion', () => {
  it('uses pure resolution without any request when possible', async () => {
    const { fetch, calls } = scripted({});
    expect(await resolveVideoUrlWithExpansion(VIDEO, { fetch })).toMatchObject({
      ok: true,
      platform: 'tiktok',
    });
    expect(await resolveVideoUrlWithExpansion('https://vimeo.com/1', { fetch })).toMatchObject({
      ok: false,
      reason: 'unsupported_host',
    });
    expect(calls).toHaveLength(0);
  });

  it('expands short links and reports why expansion failed', async () => {
    const ok = await resolveVideoUrlWithExpansion(
      SHORT,
      scripted({ [SHORT]: { status: 301, location: VIDEO } }),
    );
    expect(ok).toMatchObject({
      ok: true,
      platformVideoId: '7375040130798587154',
      expandedFrom: SHORT,
    });
    const bad = await resolveVideoUrlWithExpansion(SHORT, scripted({ [SHORT]: { status: 404 } }));
    expect(bad).toMatchObject({
      ok: false,
      reason: 'short_link_unresolved',
      failure: 'http_error',
    });
  });

  it('recognizes TikTok short links purely', () => {
    expect(isTikTokShortLink('https://vt.tiktok.com/ZSabc/')).toBe(true);
    expect(isTikTokShortLink(VIDEO)).toBe(false);
  });
});
