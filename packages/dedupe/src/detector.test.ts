import { describe, expect, it } from 'vitest';
import {
  checkThumbnailUrl,
  fetchThumbnail,
  isPublicAddress,
  safeLookup,
  type HopResponse,
  type HopTransport,
} from './fetch.ts';
import { decodeImage } from './image.ts';
import { hammingDistance, hashBands, perceptualHash } from './phash.ts';
import { assessPair, creatorKeys, summarizeEvidence, type MatchProfile } from './similarity.ts';
import { boxed, rescale, syntheticImage, toJpeg, watermarked } from './testing.ts';
import { hashImageBytes } from './thumbnail.ts';
import { compareTokens, tokenize } from './tokens.ts';

const hashOf = (bytes: Uint8Array) => hashImageBytes(bytes).hash!;

describe('text tokens', () => {
  it('drops stopwords, generic tags, URLs and mentions; keeps numbers apart', () => {
    expect(
      tokenize(
        'When the CAT hears the treat bag 😂 #funny #cat #fyp @someone https://x.y/z part 2',
      ),
    ).toEqual({
      words: ['bag', 'cat', 'hear', 'part', 'treat'],
      numbers: ['2'],
    });
  });

  it('flags conflicting numbers (part 1 vs part 2)', () => {
    expect(
      compareTokens(tokenize('cat vs vacuum part 1'), tokenize('cat vs vacuum part 2'))
        ?.numbersConflict,
    ).toBe(true);
    expect(
      compareTokens(tokenize('cat vs vacuum part 1'), tokenize('cat vs vacuum'))?.numbersConflict,
    ).toBe(false);
  });
});

describe('perceptual hash', () => {
  const base = syntheticImage(7);
  const original = hashOf(toJpeg(base));

  it('is stable under re-encoding, rescaling, pillar-boxing and a small watermark', () => {
    expect(
      hammingDistance(original, hashOf(toJpeg(rescale(base, 720, 1280), 60))),
    ).toBeLessThanOrEqual(3);
    expect(
      hammingDistance(original, hashOf(toJpeg(rescale(base, 180, 320), 70))),
    ).toBeLessThanOrEqual(4);
    // YouTube Shorts style: the 9:16 frame inside a 4:3 black canvas.
    expect(hammingDistance(original, hashOf(toJpeg(boxed(base, 480, 360))))).toBeLessThanOrEqual(7);
    expect(hammingDistance(original, hashOf(toJpeg(watermarked(base))))).toBeLessThanOrEqual(7);
  });

  it('separates unrelated images', () => {
    for (const seed of [8, 9, 10, 11, 12]) {
      expect(
        hammingDistance(original, hashOf(toJpeg(syntheticImage(seed)))),
      ).toBeGreaterThanOrEqual(18);
    }
  });

  it('refuses to hash uniform frames and produces 8 search bands', () => {
    const black = { width: 64, height: 64, data: new Uint8Array(64 * 64 * 4).fill(0) };
    expect(perceptualHash(black)).toEqual({ kind: 'uninformative' });
    expect(hashBands('0123456789abcdef')).toEqual([
      '0:01',
      '1:23',
      '2:45',
      '3:67',
      '4:89',
      '5:ab',
      '6:cd',
      '7:ef',
    ]);
  });

  it('sniffs formats from bytes, not headers', () => {
    expect(decodeImage(new TextEncoder().encode('<html>not an image</html>'))).toMatchObject({
      ok: false,
      status: 'not_an_image',
    });
    expect(
      decodeImage(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])),
    ).toMatchObject({
      ok: false,
      status: 'unsupported_format',
    });
    expect(decodeImage(new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x01]))).toMatchObject({
      ok: false,
      status: 'decode_failed',
    });
  });
});

// ── similarity ──────────────────────────────────────────────────────────────
const img = (seed: number) => hashOf(toJpeg(syntheticImage(seed)));
const catHash = img(7);
const catHashRepost = hashOf(toJpeg(boxed(syntheticImage(7), 480, 360)));
const published = new Date('2026-09-27T10:00:00Z');

function profile(over: Partial<MatchProfile> & { title?: string }): MatchProfile {
  return {
    videoId: over.videoId ?? 'a',
    platform: over.platform ?? 'youtube',
    durationMs: over.durationMs === undefined ? 42_000 : over.durationMs,
    publishedAt: over.publishedAt === undefined ? published : over.publishedAt,
    creatorKeys: over.creatorKeys ?? creatorKeys('Fixture Pets'),
    phash: over.phash === undefined ? catHash : over.phash,
    tokens: tokenize(over.title ?? 'Cat discovers the vacuum cleaner'),
    references: over.references ?? [],
  };
}

describe('assessPair', () => {
  it('auto-confirms only with a very close thumbnail + matching duration + supporting metadata, across platforms', () => {
    const r = assessPair(
      profile({}),
      profile({
        videoId: 'b',
        platform: 'twitch',
        phash: catHashRepost,
        durationMs: 42_400,
        title: 'cat DISCOVERS vacuum cleaner lol',
      }),
    );
    expect(r.decision).toBe('auto_confirm');
    expect(r.positiveSignals).toEqual(['thumbnail', 'duration', 'title', 'creator']);
    expect(r.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it('near-identical thumbnail + title but NO duration → possible, never auto', () => {
    const r = assessPair(
      profile({}),
      profile({
        videoId: 'b',
        platform: 'tiktok',
        phash: catHashRepost,
        durationMs: null,
        creatorKeys: [],
      }),
    );
    expect(r.decision).toBe('possible');
    expect(r.autoBlockers).toContain('NO_DURATION');
  });

  it('same thumbnail but very different duration → vetoed', () => {
    const r = assessPair(
      profile({}),
      profile({ videoId: 'b', platform: 'twitch', durationMs: 190_000 }),
    );
    expect(r.decision).toBe('no_match');
    expect(r.vetoes).toEqual(['DURATION_MISMATCH']);
  });

  it('similar title but unrelated thumbnail → no match (a trend, not a duplicate)', () => {
    const r = assessPair(
      profile({
        platform: 'tiktok',
        durationMs: null,
        title: 'when the cat hears the treat bag #funny #cat',
        creatorKeys: creatorKeys('Fixture Creator'),
      }),
      profile({
        videoId: 'b',
        platform: 'tiktok',
        durationMs: null,
        phash: img(99),
        title: 'my cat when she hears the treat bag 😂 #cat #fyp',
        creatorKeys: creatorKeys('someone else'),
      }),
    );
    expect(r.evidence.title.grade).toBe('strong');
    expect(r.evidence.thumbnail.grade).toBe('different');
    expect(r.decision).toBe('no_match');
  });

  describe('same platform without visual evidence (live pilot, 2026-10-03)', () => {
    const twitchClip = (videoId: string, title: string, at: string) =>
      profile({
        videoId,
        platform: 'twitch',
        phash: null,
        durationMs: 60_000,
        publishedAt: new Date(at),
        creatorKeys: creatorKeys('fixturestreamer'),
        title,
      });

    it('A: same creator + both 60 s + unrelated titles + no thumbnails → not suggested', () => {
      const r = assessPair(
        twitchClip('a', 'равшан про бустера', '2026-10-02T20:00:00Z'),
        twitchClip('b', '010 ЛЫСЫЙ РАВШАН БРЕЕТ', '2026-10-02T22:12:00Z'),
      );
      // Exactly the live evidence: duration match + same creator + close publication = 40.
      expect(r.positiveSignals).toEqual(['duration', 'creator']);
      expect(r.score).toBe(40);
      expect(r.decision).toBe('no_match');
      expect(r.vetoes).toEqual(['SAME_PLATFORM_WITHOUT_VISUAL_OR_TITLE_EVIDENCE']);
      // Untitled clips (")") are no different.
      expect(
        assessPair(
          twitchClip('a', ')', '2026-10-02T20:00:00Z'),
          twitchClip('b', '010 ЛЫСЫЙ РАВШАН БРЕЕТ', '2026-10-02T22:30:00Z'),
        ).decision,
      ).toBe('no_match');
    });

    it('B: same creator + same duration + strongly matching distinctive titles → still possible', () => {
      const r = assessPair(
        twitchClip('a', 'streamer falls off the gaming chair mid raid', '2026-10-02T20:00:00Z'),
        twitchClip('b', 'Streamer FALLS off gaming chair mid-raid', '2026-10-02T20:40:00Z'),
      );
      expect(r.evidence.title.grade).toBe('strong');
      expect(r.decision).toBe('possible');
      expect(r.autoBlockers).toEqual(
        expect.arrayContaining(['NO_THUMBNAIL_HASH', 'SAME_PLATFORM']),
      );
    });

    it('a shared referencing post still counts as independent evidence', () => {
      const r = assessPair(
        { ...twitchClip('a', 'one', '2026-10-02T20:00:00Z'), references: ['at://post/1'] },
        { ...twitchClip('b', 'two', '2026-10-02T20:30:00Z'), references: ['at://post/1'] },
      );
      expect(r.vetoes).toEqual([]);
      expect(r.decision).toBe('possible');
    });

    it('C: a strong cross-platform visual match is unchanged', () => {
      const r = assessPair(
        profile({}),
        profile({
          videoId: 'b',
          platform: 'twitch',
          phash: catHashRepost,
          durationMs: 42_400,
          title: 'cat DISCOVERS vacuum cleaner lol',
        }),
      );
      expect(r.decision).toBe('auto_confirm');
      // Cross-platform without thumbnails is not affected by the same-platform rule either.
      const noVisual = assessPair(
        profile({ phash: null, title: 'abc' }),
        profile({ videoId: 'b', platform: 'tiktok', phash: null, title: 'xyz' }),
      );
      expect(noVisual.vetoes).toEqual([]);
    });
  });

  it('one strong signal alone is never enough', () => {
    const thumbOnly = assessPair(
      profile({ durationMs: null, title: 'abc', creatorKeys: [] }),
      profile({
        videoId: 'b',
        platform: 'tiktok',
        durationMs: null,
        title: 'xyz',
        creatorKeys: [],
      }),
    );
    expect(thumbOnly.evidence.thumbnail.grade).toBe('identical');
    expect(thumbOnly.decision).toBe('no_match');
    const titleOnly = assessPair(
      profile({ phash: null, durationMs: null, creatorKeys: [] }),
      profile({ videoId: 'b', platform: 'tiktok', phash: null, durationMs: null, creatorKeys: [] }),
    );
    expect(titleOnly.evidence.title.grade).toBe('strong');
    expect(titleOnly.decision).toBe('no_match');
  });

  it('handles missing thumbnail, duration or title with the remaining evidence', () => {
    const noThumb = assessPair(
      profile({ phash: null }),
      profile({ videoId: 'b', platform: 'twitch', phash: null }),
    );
    expect(noThumb.evidence.thumbnail.grade).toBe('unavailable');
    expect(noThumb.decision).toBe('possible');
    expect(noThumb.autoBlockers).toContain('NO_THUMBNAIL_HASH');
    const noTitle = assessPair(
      profile({ title: '' }),
      profile({ videoId: 'b', platform: 'twitch', title: '', creatorKeys: [] }),
    );
    expect(noTitle.evidence.title.grade).toBe('unavailable');
    expect(noTitle.decision).toBe('possible');
    expect(noTitle.autoBlockers).toContain('NO_SUPPORTING_METADATA');
  });

  it('keeps same-platform pairs and conflicting part numbers for humans', () => {
    const sameP = assessPair(profile({}), profile({ videoId: 'b', phash: catHashRepost }));
    expect(sameP.decision).toBe('possible');
    expect(sameP.autoBlockers).toContain('SAME_PLATFORM');
    const parts = assessPair(
      profile({ title: 'Cat vs vacuum part 1' }),
      profile({ videoId: 'b', platform: 'twitch', title: 'Cat vs vacuum part 2' }),
    );
    expect(parts.evidence.title.numbersConflict).toBe(true);
    expect(parts.decision).not.toBe('auto_confirm');
  });

  it('never uses popularity or category: identical inputs except views give identical results', () => {
    expect(
      summarizeEvidence(
        assessPair(profile({}), profile({ videoId: 'b', platform: 'twitch' })).evidence,
      )[0],
    ).toMatch(/^Thumbnail: identical \(distance 0\/64\)$/);
  });
});

// ── safe thumbnail fetching ─────────────────────────────────────────────────
function response(over: Partial<HopResponse> & { chunks?: Uint8Array[] }): HopResponse {
  const chunks = over.chunks ?? [];
  return {
    status: over.status ?? 200,
    location: over.location ?? null,
    contentType: over.contentType === undefined ? 'image/jpeg' : over.contentType,
    contentLength: over.contentLength ?? null,
    body: chunks,
    destroy: () => undefined,
  };
}

describe('thumbnail fetch security', () => {
  it('accepts only https URLs on known thumbnail CDNs', () => {
    expect(checkThumbnailUrl('https://i.ytimg.com/vi/x/hqdefault.jpg').ok).toBe(true);
    expect(checkThumbnailUrl('https://p16-sign.tiktokcdn-us.com/obj.jpeg?x=1').ok).toBe(true);
    for (const [url, status] of [
      ['http://i.ytimg.com/vi/x/hq.jpg', 'rejected_url'],
      ['https://user:pw@i.ytimg.com/x.jpg', 'rejected_url'],
      ['https://i.ytimg.com:8443/x.jpg', 'rejected_url'],
      ['https://127.0.0.1/x.jpg', 'rejected_url'],
      ['https://[::1]/x.jpg', 'rejected_url'],
      ['https://169.254.169.254/latest/meta-data', 'rejected_url'],
      ['https://metadata.google.internal/x', 'host_not_allowed'],
      ['https://evilytimg.com/x.jpg', 'host_not_allowed'],
      ['https://i.ytimg.com.attacker.test/x.jpg', 'host_not_allowed'],
      ['file:///etc/passwd', 'rejected_url'],
    ] as const) {
      expect(checkThumbnailUrl(url)).toMatchObject({ ok: false, status });
    }
  });

  it('classifies addresses: only globally routable unicast is public', () => {
    for (const ip of [
      '10.0.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.5.4',
      '192.168.1.1',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '224.0.0.1',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ['142.250.72.14', '2607:f8b0:4005:80a::200e', '8.8.8.8'])
      expect(isPublicAddress(ip), ip).toBe(true);
  });

  it('refuses a CDN name that resolves to a private address at connect time (DNS rebinding)', async () => {
    const lookup = safeLookup((_host, _opts, cb) => {
      cb(null, [
        { address: '142.250.72.14', family: 4 },
        { address: '10.0.0.7', family: 4 },
      ]);
    });
    const err = await new Promise<Error | null>((resolve) => {
      lookup('i.ytimg.com', {}, (e) => {
        resolve(e);
      });
    });
    expect(err?.message).toMatch(/non-public address \(10\.0\.0\.7\)/);
  });

  it('re-validates every redirect hop and caps the number of hops', async () => {
    const toInternal: HopTransport = () =>
      Promise.resolve(response({ status: 302, location: 'https://10.0.0.1/admin' }));
    expect(
      await fetchThumbnail('https://i.ytimg.com/x.jpg', { transport: toInternal }),
    ).toMatchObject({
      ok: false,
      status: 'rejected_url',
    });
    const offCdn: HopTransport = () =>
      Promise.resolve(response({ status: 301, location: 'https://example.com/x.jpg' }));
    expect(await fetchThumbnail('https://i.ytimg.com/x.jpg', { transport: offCdn })).toMatchObject({
      status: 'host_not_allowed',
    });
    const loop: HopTransport = (url) =>
      Promise.resolve(response({ status: 302, location: `${url.href}?again` }));
    expect(await fetchThumbnail('https://i.ytimg.com/x.jpg', { transport: loop })).toMatchObject({
      status: 'too_many_redirects',
    });
  });

  it('requires an image content type and bounds the body size', async () => {
    const html: HopTransport = () => Promise.resolve(response({ contentType: 'text/html' }));
    expect(await fetchThumbnail('https://i.ytimg.com/x.jpg', { transport: html })).toMatchObject({
      status: 'not_an_image',
    });
    const declared: HopTransport = () => Promise.resolve(response({ contentLength: 50_000_000 }));
    expect(
      await fetchThumbnail('https://i.ytimg.com/x.jpg', { transport: declared }),
    ).toMatchObject({ status: 'too_large' });
    const streamed: HopTransport = () =>
      Promise.resolve(
        response({ chunks: Array.from({ length: 30 }, () => new Uint8Array(100_000)) }),
      );
    expect(
      await fetchThumbnail('https://i.ytimg.com/x.jpg', { transport: streamed }),
    ).toMatchObject({ status: 'too_large' });
  });

  it('times out slow servers and never sends credentials', async () => {
    const seen: URL[] = [];
    const slow: HopTransport = (url, signal) => {
      seen.push(url);
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(signal.reason as Error);
        });
      });
    };
    const policy = { allowedHosts: ['ytimg.com'], maxBytes: 1000, timeoutMs: 20, maxRedirects: 1 };
    expect(
      await fetchThumbnail('https://i.ytimg.com/x.jpg', { transport: slow, policy }),
    ).toMatchObject({ status: 'timeout' });
    expect(seen[0]?.username).toBe('');
  });

  describe('generic binary content-type (live: Bluesky video CDN, 2026-10-03)', () => {
    const BSKY = 'https://video.bsky.app/watch/did%3Aplc%3Afixture/bafkreifixture/thumbnail.jpg';
    const CDN = 'https://video.cdn.bsky.app/hls/did:plc:fixture/bafkreifixture/thumbnail.jpg';
    // The observed chain: 302 to the CDN, then 200 application/octet-stream.
    const bluesky =
      (body: Uint8Array, contentType = 'application/octet-stream'): HopTransport =>
      (url) =>
        Promise.resolve(
          url.hostname === 'video.bsky.app'
            ? response({ status: 302, location: CDN })
            : response({ contentType, chunks: [body] }),
        );

    it('accepts real JPEG bytes from the allowlisted Bluesky CDN', async () => {
      const jpeg = toJpeg(syntheticImage(5, 64, 64));
      const r = await fetchThumbnail(BSKY, { transport: bluesky(jpeg) });
      expect(r).toMatchObject({ ok: true, contentType: 'image/jpeg', finalUrl: CDN });
    });

    it('still requires the bytes to be a supported image', async () => {
      const html = new TextEncoder().encode('<html>not an image</html>');
      expect(await fetchThumbnail(BSKY, { transport: bluesky(html) })).toMatchObject({
        ok: false,
        status: 'not_an_image',
      });
      const gif = new TextEncoder().encode('GIF89a....');
      expect(await fetchThumbnail(BSKY, { transport: bluesky(gif) })).toMatchObject({
        ok: false,
        status: 'unsupported_format',
      });
    });

    it('does not accept application/octet-stream from other hosts, even allowlisted ones', async () => {
      const jpeg = toJpeg(syntheticImage(5, 64, 64));
      const ytOctet: HopTransport = () =>
        Promise.resolve(response({ contentType: 'application/octet-stream', chunks: [jpeg] }));
      expect(
        await fetchThumbnail('https://i.ytimg.com/x.jpg', { transport: ytOctet }),
      ).toMatchObject({ ok: false, status: 'not_an_image' });
      // cdn.bsky.app (avatars etc.) is allowlisted but not a generic-binary host.
      expect(
        await fetchThumbnail('https://cdn.bsky.app/img/x.jpg', { transport: ytOctet }),
      ).toMatchObject({ ok: false, status: 'not_an_image' });
    });

    it('keeps size limits and redirect validation for the exempt host', async () => {
      const big: HopTransport = (url) =>
        Promise.resolve(
          url.hostname === 'video.bsky.app'
            ? response({ status: 302, location: CDN })
            : response({
                contentType: 'application/octet-stream',
                chunks: Array.from({ length: 30 }, () => new Uint8Array(100_000)),
              }),
        );
      expect(await fetchThumbnail(BSKY, { transport: big })).toMatchObject({ status: 'too_large' });
      const toPrivate: HopTransport = () =>
        Promise.resolve(response({ status: 302, location: 'https://10.0.0.1/thumbnail.jpg' }));
      expect(await fetchThumbnail(BSKY, { transport: toPrivate })).toMatchObject({
        status: 'rejected_url',
      });
      const httpCdn: HopTransport = () =>
        Promise.resolve(response({ status: 302, location: CDN.replace('https://', 'http://') }));
      expect(await fetchThumbnail(BSKY, { transport: httpCdn })).toMatchObject({
        status: 'rejected_url',
      });
    });
  });

  it('returns bytes for a valid image response', async () => {
    const bytes = toJpeg(syntheticImage(3, 64, 64));
    const ok: HopTransport = () => Promise.resolve(response({ chunks: [bytes] }));
    const r = await fetchThumbnail('https://i.ytimg.com/x.jpg', { transport: ok });
    expect(r.ok && r.bytes.byteLength).toBe(bytes.byteLength);
  });
});
