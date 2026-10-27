import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { schema, type AnyDatabase } from '@vd/db';
import { NOW, createTestDb, hoursAgo, seedFeed } from '@vd/review/testing';
import {
  describeDownload,
  downloadFilename,
  handleMediaRequest,
  isForbiddenHost,
  parseRange,
  resolveAssetUrl,
  type DownloadDeps,
} from './download.ts';

const MP4_BYTES = Buffer.from('00000018667479706d703432000000006d7034326973736d', 'hex'); // ftyp box
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

let db: AnyDatabase;
let close: () => Promise<void>;
let seeded: Awaited<ReturnType<typeof seedFeed>>;
let dir: string;

beforeEach(async () => {
  const t = await createTestDb();
  db = t.db;
  close = t.close;
  seeded = await seedFeed(t.db);
  dir = await mkdtemp(path.join(tmpdir(), 'vd-media-'));
  await mkdir(path.join(dir, 'clips'), { recursive: true });
  await writeFile(path.join(dir, 'clips', 'cat.mp4'), MP4_BYTES);
});
afterEach(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
});

const deps = (over: Partial<DownloadDeps> = {}): DownloadDeps => ({
  db,
  assetsDir: dir,
  maxBytes: 10 * 1024 * 1024,
  allowedHosts: null,
  now: () => NOW,
  fetch: () => {
    throw new Error('network access attempted');
  },
  logger: { error: vi.fn() },
  ...over,
});

const addAsset = (
  videoId: string,
  url: string,
  extra: Partial<typeof schema.mediaAssets.$inferInsert> = {},
) =>
  db.insert(schema.mediaAssets).values({
    videoId,
    kind: 'official_download',
    url,
    provider: 'rights-holder',
    ...extra,
  });

const get = (
  d: DownloadDeps,
  clusterId: string,
  init: { query?: string; headers?: Record<string, string>; mode?: 'download' | 'inline' } = {},
) =>
  handleMediaRequest(
    d,
    new Request(`http://dashboard.test/api/candidates/${clusterId}/download${init.query ?? ''}`, {
      headers: init.headers ?? {},
    }),
    clusterId,
    init.mode ?? 'download',
  );

const acquisitions = (clusterId: string) =>
  db
    .select()
    .from(schema.acquisitionEvents)
    .where(eq(schema.acquisitionEvents.clusterId, clusterId))
    .orderBy(desc(schema.acquisitionEvents.createdAt));

/** A fake fetch serving one remote MP4; records what it was asked. */
function fakeRemote(
  options: {
    body?: Uint8Array;
    contentType?: string;
    contentLength?: boolean;
    status?: number;
    redirectTo?: string;
  } = {},
) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const body = new Uint8Array(options.body ?? MP4_BYTES);
  const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url, headers });
    if (options.redirectTo && calls.length === 1) {
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location: options.redirectTo } }),
      );
    }
    const h = new Headers({
      'content-type': options.contentType ?? 'video/mp4',
      'set-cookie': 'upstream=secret; HttpOnly',
      'x-upstream-token': 'leak-me',
    });
    if (options.contentLength !== false) h.set('content-length', String(body.byteLength));
    return Promise.resolve(
      new Response(options.status === 404 ? null : body, {
        status: options.status ?? 200,
        headers: h,
      }),
    );
  });
  return { fetch: fetchImpl as unknown as typeof fetch, calls };
}

describe('filename', () => {
  it('is creator-short-title-video-id.ext, sanitized', () => {
    expect(
      downloadFilename({
        creator: 'Fixture Pets',
        title: 'Cat discovers the vacuum cleaner',
        platformVideoId: 'vdFixture01',
        ext: 'mp4',
      }),
    ).toBe('fixture-pets-cat-discovers-the-vacuum-cleaner-vdfixture01.mp4');
    expect(
      downloadFilename({
        creator: '../../etc/passwd',
        title: 'Ünïcödé "quotes" \r\n; filename=evil.exe',
        platformVideoId: '7411111111111111111',
        ext: 'mp4',
      }),
    ).toBe('etc-passwd-unicode-quotes-filename-evil-exe-7411111111111111111.mp4');
    expect(downloadFilename({ creator: null, title: null, platformVideoId: '', ext: 'webm' })).toBe(
      'video.webm',
    );
    expect(
      downloadFilename({
        creator: 'a',
        title: 'x'.repeat(200),
        platformVideoId: 'id',
        ext: '../mp4',
      }),
    ).toBe(`a-${'x'.repeat(40)}-id.bin`);
  });
});

describe('asset url validation', () => {
  const d = () => ({ assetsDir: dir, allowedHosts: null });

  it('serves local files only from inside the media directory', async () => {
    const r = await resolveAssetUrl('local:clips/cat.mp4', d());
    expect(r.kind).toBe('local');
    expect(r.contentType).toBe('video/mp4');
    const f = await resolveAssetUrl(`file://${path.join(dir, 'clips', 'cat.mp4')}`, d());
    expect(f.kind).toBe('local');
  });

  it('rejects path traversal, absolute paths, symlink escapes, and null bytes', async () => {
    await expect(resolveAssetUrl('local:../outside.mp4', d())).rejects.toMatchObject({
      status: 400,
    });
    await expect(resolveAssetUrl('local:clips/../../x.mp4', d())).rejects.toMatchObject({
      status: 400,
    });
    await expect(resolveAssetUrl('local:/etc/passwd.mp4', d())).rejects.toMatchObject({
      status: 400,
    });
    await expect(resolveAssetUrl('local:clips/cat.mp4\0.mp4', d())).rejects.toMatchObject({
      status: 400,
    });
    await expect(resolveAssetUrl('file:///etc/hosts.mp4', d())).rejects.toMatchObject({
      status: 400,
    });
    // A symlink inside the directory pointing outside it is refused too.
    const outside = path.join(tmpdir(), `vd-outside-${process.pid}.mp4`);
    await writeFile(outside, MP4_BYTES);
    try {
      await symlink(outside, path.join(dir, 'clips', 'link.mp4'));
      await expect(resolveAssetUrl('local:clips/link.mp4', d())).rejects.toMatchObject({
        status: 400,
      });
    } finally {
      await rm(outside, { force: true });
    }
    // Local assets are never served without a configured directory.
    await expect(
      resolveAssetUrl('local:clips/cat.mp4', { assetsDir: null, allowedHosts: null }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('rejects arbitrary and unsafe remote URLs', async () => {
    for (const bad of [
      'http://cdn.example/clip.mp4',
      'ftp://cdn.example/clip.mp4',
      'data:video/mp4;base64,AAAA',
      'javascript:alert(1)',
      'https://user:pass@cdn.example/clip.mp4',
      'https://localhost/clip.mp4',
      'https://127.0.0.1/clip.mp4',
      'https://10.0.0.5/clip.mp4',
      'https://169.254.169.254/latest/meta-data.mp4',
      'https://[::1]/clip.mp4',
      'https://intranet/clip.mp4',
      'https://nas.local/clip.mp4',
      'not a url',
      '',
    ]) {
      await expect(resolveAssetUrl(bad, d()), bad).rejects.toMatchObject({ status: 400 });
    }
    await expect(resolveAssetUrl('https://cdn.example/clip.exe', d())).rejects.toMatchObject({
      status: 415,
    });
    await expect(resolveAssetUrl('https://cdn.example/clip', d())).rejects.toMatchObject({
      status: 415,
    });
    await expect(resolveAssetUrl('local:clips/cat.txt', d())).rejects.toMatchObject({
      status: 415,
    });
    const ok = await resolveAssetUrl('https://cdn.example/path/clip.webm', d());
    expect(ok).toMatchObject({ kind: 'remote', contentType: 'video/webm' });
  });

  it('honours the host allowlist', async () => {
    const allow = { assetsDir: null, allowedHosts: ['cdn.example'] };
    await expect(resolveAssetUrl('https://cdn.example/a.mp4', allow)).resolves.toBeTruthy();
    await expect(resolveAssetUrl('https://eu.cdn.example/a.mp4', allow)).resolves.toBeTruthy();
    await expect(resolveAssetUrl('https://evil.example/a.mp4', allow)).rejects.toMatchObject({
      status: 403,
    });
    await expect(resolveAssetUrl('https://cdn.example.evil/a.mp4', allow)).rejects.toMatchObject({
      status: 403,
    });
    expect(isForbiddenHost('cdn.example')).toBe(false);
    expect(isForbiddenHost('192.168.1.1')).toBe(true);
  });

  it('parses byte ranges', () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=0-500', 100)).toEqual({ start: 0, end: 99 });
    expect(() => parseRange('bytes=100-', 100)).toThrow();
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
  });
});

describe('GET /api/candidates/:id/download', () => {
  it('streams a local MP4 as an attachment with the right type and filename, and records obtained', async () => {
    await addAsset(seeded.breakout.videoId, 'local:clips/cat.mp4');
    const res = await get(deps(), seeded.breakout.clusterId);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="fixture-pets-cat-discovers-the-vacuum-cleaner-vdfixture01.mp4"',
    );
    expect(res.headers.get('content-length')).toBe(String(MP4_BYTES.byteLength));
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(Buffer.from(await res.arrayBuffer()).equals(MP4_BYTES)).toBe(true);
    const events = await acquisitions(seeded.breakout.clusterId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: 'obtained',
      videoId: seeded.breakout.videoId,
      note: 'Downloaded via dashboard (official_download from rights-holder)',
    });
    // A second download of the same asset does not duplicate the record.
    await (await get(deps(), seeded.breakout.clusterId)).arrayBuffer();
    expect(await acquisitions(seeded.breakout.clusterId)).toHaveLength(1);
  });

  it('serves byte ranges for the inline player and never records a preview as obtained', async () => {
    await addAsset(seeded.breakout.videoId, 'local:clips/cat.mp4');
    const res = await get(deps(), seeded.breakout.clusterId, {
      mode: 'inline',
      headers: { range: 'bytes=4-7' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 4-7/${MP4_BYTES.byteLength}`);
    expect(res.headers.get('content-length')).toBe('4');
    expect(res.headers.get('content-disposition')).toMatch(/^inline; filename="/);
    expect(Buffer.from(await res.arrayBuffer()).toString('ascii')).toBe('ftyp');
    expect(await acquisitions(seeded.breakout.clusterId)).toHaveLength(0);
    const bad = await get(deps(), seeded.breakout.clusterId, { headers: { range: 'bytes=999-' } });
    expect(bad.status).toBe(416);
  });

  it('404s for a missing asset, an unknown candidate, and a malformed id — recording nothing', async () => {
    const none = await get(deps(), seeded.breakout.clusterId);
    expect(none.status).toBe(404);
    expect(await none.json()).toEqual({
      error: 'No downloadable media asset is available for this video.',
    });
    expect((await get(deps(), UNKNOWN)).status).toBe(404);
    expect(await (await get(deps(), UNKNOWN)).json()).toEqual({ error: 'candidate not found' });
    expect((await get(deps(), '../../etc/passwd')).status).toBe(404);
    expect((await get(deps(), seeded.breakout.clusterId, { query: '?video=nope' })).status).toBe(
      400,
    );
    // An expired asset is not an asset.
    await addAsset(seeded.breakout.videoId, 'local:clips/cat.mp4', { expiresAt: hoursAgo(1) });
    expect((await get(deps(), seeded.breakout.clusterId)).status).toBe(404);
    // A row whose file is gone is reported, not served.
    await addAsset(seeded.provisional.videoId, 'local:clips/gone.mp4');
    const gone = await get(deps(), seeded.provisional.clusterId);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: 'asset file is missing' });
    expect(await acquisitions(seeded.breakout.clusterId)).toHaveLength(0);
    expect(await acquisitions(seeded.provisional.clusterId)).toHaveLength(0);
  });

  it('refuses traversal, arbitrary URLs and unsupported media types stored in media_assets', async () => {
    await addAsset(seeded.breakout.videoId, 'local:../../../etc/passwd.mp4');
    const traversal = await get(deps(), seeded.breakout.clusterId);
    expect(traversal.status).toBe(400);
    expect(await traversal.json()).toEqual({ error: 'asset path escapes the media directory' });

    await addAsset(seeded.provisional.videoId, 'http://169.254.169.254/latest/meta-data.mp4');
    const ssrf = await get(deps(), seeded.provisional.clusterId);
    expect(ssrf.status).toBe(400);

    await addAsset(seeded.insufficient.videoId, 'https://cdn.example/payload.exe');
    const type = await get(deps(), seeded.insufficient.clusterId);
    expect(type.status).toBe(415);

    for (const c of [seeded.breakout, seeded.provisional, seeded.insufficient])
      expect(await acquisitions(c.clusterId)).toHaveLength(0);
  });

  it('rejects an oversized local asset', async () => {
    await addAsset(seeded.breakout.videoId, 'local:clips/cat.mp4');
    const res = await get(deps({ maxBytes: 4 }), seeded.breakout.clusterId);
    expect(res.status).toBe(413);
    expect(await acquisitions(seeded.breakout.clusterId)).toHaveLength(0);
  });

  it('streams an authorized remote asset without leaking credentials either way', async () => {
    await addAsset(seeded.breakout.videoId, 'https://cdn.rights-holder.example/clips/cat.mp4', {
      provider: 'rights-holder-api',
    });
    const remote = fakeRemote();
    const res = await get(
      deps({ fetch: remote.fetch, allowedHosts: ['rights-holder.example'] }),
      seeded.breakout.clusterId,
      {
        headers: { cookie: 'vd_access=deadbeef', authorization: 'Bearer dashboard-secret' },
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="fixture-pets-cat-discovers-the-vacuum-cleaner-vdfixture01.mp4"',
    );
    expect(res.headers.get('content-length')).toBe(String(MP4_BYTES.byteLength));
    expect(Buffer.from(await res.arrayBuffer()).equals(MP4_BYTES)).toBe(true);
    // Upstream saw no dashboard credentials…
    expect(remote.calls).toHaveLength(1);
    expect(remote.calls[0]!.url).toBe('https://cdn.rights-holder.example/clips/cat.mp4');
    expect(Object.keys(remote.calls[0]!.headers)).not.toContain('cookie');
    expect(Object.keys(remote.calls[0]!.headers)).not.toContain('authorization');
    // …and the browser sees none of the upstream's.
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-upstream-token')).toBeNull();
    const events = await acquisitions(seeded.breakout.clusterId);
    expect(events).toHaveLength(1);
    expect(events[0]!.note).toBe(
      'Downloaded via dashboard (official_download from rights-holder-api)',
    );
  });

  it('validates redirects, upstream types, and sizes for remote assets', async () => {
    await addAsset(seeded.breakout.videoId, 'https://cdn.example/clip.mp4');
    // Redirect to a private address is refused.
    const toPrivate = fakeRemote({ redirectTo: 'https://10.1.2.3/clip.mp4' });
    expect((await get(deps({ fetch: toPrivate.fetch }), seeded.breakout.clusterId)).status).toBe(
      400,
    );
    expect(toPrivate.calls).toHaveLength(1);
    // Redirect to a public host is followed once and revalidated.
    const toPublic = fakeRemote({ redirectTo: 'https://edge.cdn.example/clip.mp4' });
    const ok = await get(deps({ fetch: toPublic.fetch }), seeded.breakout.clusterId);
    expect(ok.status).toBe(200);
    expect(toPublic.calls.map((c) => c.url)).toEqual([
      'https://cdn.example/clip.mp4',
      'https://edge.cdn.example/clip.mp4',
    ]);
    await ok.arrayBuffer();
    // Wrong upstream type, oversized, and upstream 404.
    const html = fakeRemote({ contentType: 'text/html' });
    expect((await get(deps({ fetch: html.fetch }), seeded.breakout.clusterId)).status).toBe(415);
    const big = fakeRemote();
    expect(
      (await get(deps({ fetch: big.fetch, maxBytes: 4 }), seeded.breakout.clusterId)).status,
    ).toBe(413);
    const missing = fakeRemote({ status: 404 });
    expect((await get(deps({ fetch: missing.fetch }), seeded.breakout.clusterId)).status).toBe(404);
    // No content-length: the stream itself is capped.
    const unsized = fakeRemote({ contentLength: false });
    const capped = await get(
      deps({ fetch: unsized.fetch, maxBytes: 4 }),
      seeded.breakout.clusterId,
    );
    expect(capped.status).toBe(200);
    await expect(capped.arrayBuffer()).rejects.toThrow(/size limit/);
    // The network is never touched when no asset exists.
    const never = fakeRemote();
    expect((await get(deps({ fetch: never.fetch }), seeded.provisional.clusterId)).status).toBe(
      404,
    );
    expect(never.calls).toHaveLength(0);
  });

  it('prefers the representative version and lets ?video= pick another', async () => {
    await writeFile(path.join(dir, 'clips', 'other.webm'), Buffer.from('other'));
    await addAsset(seeded.breakout.videoId, 'local:clips/cat.mp4');
    await addAsset(seeded.provisional.videoId, 'local:clips/other.webm');
    const info = await describeDownload(deps(), seeded.breakout.clusterId);
    expect(info).toMatchObject({
      available: true,
      videoId: seeded.breakout.videoId,
      contentType: 'video/mp4',
      playable: true,
      source: 'local',
      sizeBytes: MP4_BYTES.byteLength,
      filename: 'fixture-pets-cat-discovers-the-vacuum-cleaner-vdfixture01.mp4',
    });
    const other = await get(deps(), seeded.provisional.clusterId, {
      query: `?video=${seeded.provisional.videoId}`,
    });
    expect(other.headers.get('content-type')).toBe('video/webm');
    // A video from another candidate is not this candidate's asset.
    const wrong = await get(deps(), seeded.breakout.clusterId, {
      query: `?video=${seeded.provisional.videoId}`,
    });
    expect(wrong.status).toBe(404);
  });

  it('describes unavailability without throwing', async () => {
    expect(await describeDownload(deps(), seeded.breakout.clusterId)).toEqual({
      available: false,
      reason: 'No downloadable media asset is available for this video.',
    });
    expect(await describeDownload(deps(), UNKNOWN)).toEqual({
      available: false,
      reason: 'candidate not found',
    });
    await addAsset(seeded.breakout.videoId, 'https://cdn.example/clip.mp4');
    expect(await describeDownload(deps(), seeded.breakout.clusterId)).toMatchObject({
      available: true,
      source: 'remote',
      sizeBytes: null,
    });
  });
});
