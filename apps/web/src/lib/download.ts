/**
 * One-click downloads of OFFICIAL / authorized media assets.
 *
 * Only `media_assets` rows are ever served: an asset explicitly provided by a
 * platform's official download API, a rights holder, the creator, or a local file
 * the operator already holds. Source links are never ripped, no player/CDN URL is
 * extracted, and nothing here talks to YouTube/TikTok.
 *
 * Asset URL forms:
 * - `local:<relative path>`  — a file under MEDIA_ASSETS_DIR
 * - `file:///absolute/path`  — a file that must also live under MEDIA_ASSETS_DIR
 * - `https://host/path.mp4`  — a public https host (optionally allowlisted)
 *
 * Everything else (http:, data:, ftp:, javascript:, paths outside the assets
 * directory, private networks, credentials in the URL, unknown media types, files
 * above the size limit) is refused with a specific status.
 */
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { schema, type AnyDatabase } from '@vd/db';
import { mergedInto, recordAcquisition } from '@vd/review';

/** Media types the dashboard serves, keyed by file extension. */
export const MEDIA_TYPES: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};
const ALLOWED_CONTENT_TYPES = new Set(Object.values(MEDIA_TYPES));
/** Upstream types that carry no information; the extension decides instead. */
const GENERIC_CONTENT_TYPES = new Set(['application/octet-stream', 'binary/octet-stream']);
const MAX_REDIRECTS = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const UNAVAILABLE_MESSAGE = 'No downloadable media asset is available for this video.';

export interface DownloadDeps {
  db: AnyDatabase;
  /** Root for local assets; null = local assets are never served. */
  assetsDir: string | null;
  /** Largest asset (bytes) that will be streamed. */
  maxBytes: number;
  /** Allowed hosts for https assets (exact or subdomain); null = any public host. */
  allowedHosts: readonly string[] | null;
  fetch?: typeof fetch;
  now?: () => Date;
  logger?: { error: (obj: unknown, msg: string) => void };
}

export class DownloadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

export type AssetLocation =
  | { kind: 'local'; path: string; ext: string; contentType: string }
  | { kind: 'remote'; url: URL; ext: string; contentType: string };

// ── URL validation ─────────────────────────────────────────────────────────

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** True for hostnames that must never be fetched: loopback, link-local, private, literal IPs. */
export function isForbiddenHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return true;
  // IPv6 literals (URL keeps the brackets) and every IPv4 literal: public assets have names.
  if (h.startsWith('[') || IPV4.test(h)) return true;
  if (!h.includes('.')) return true; // bare intranet names
  return false;
}

function hostAllowed(hostname: string, allowed: readonly string[] | null): boolean {
  if (!allowed) return true;
  const h = hostname.toLowerCase();
  return allowed.some((a) => {
    const x = a.trim().toLowerCase();
    return x !== '' && (h === x || h.endsWith(`.${x}`));
  });
}

function extensionOf(p: string): string {
  const base = p.split('/').pop() ?? '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

function mediaTypeFor(ext: string): string {
  const type = MEDIA_TYPES[ext];
  if (!type) throw new DownloadError(415, `unsupported media type ".${ext || '(none)'}"`);
  return type;
}

function validateRemote(url: URL, deps: Pick<DownloadDeps, 'allowedHosts'>): URL {
  if (url.protocol !== 'https:')
    throw new DownloadError(400, `unsupported URL scheme "${url.protocol}"`);
  if (url.username || url.password)
    throw new DownloadError(400, 'asset URLs must not carry credentials');
  if (isForbiddenHost(url.hostname))
    throw new DownloadError(400, 'asset host is not a public host');
  if (!hostAllowed(url.hostname, deps.allowedHosts))
    throw new DownloadError(403, 'asset host is not in MEDIA_ASSET_HOSTS');
  return url;
}

/** Resolves a candidate local path to a real file strictly inside the assets dir. */
async function resolveLocal(candidate: string, root: string): Promise<string> {
  if (candidate.includes('\0')) throw new DownloadError(400, 'invalid asset path');
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, candidate);
  const inside = (p: string, base: string) => p === base || p.startsWith(base + path.sep);
  if (!inside(target, rootAbs) || target === rootAbs)
    throw new DownloadError(400, 'asset path escapes the media directory');
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await realpath(rootAbs);
  } catch {
    throw new DownloadError(404, 'media directory is not available');
  }
  try {
    realTarget = await realpath(target);
  } catch {
    throw new DownloadError(404, 'asset file is missing');
  }
  // Symlinks inside the directory may not point outside it.
  if (!inside(realTarget, realRoot) || realTarget === realRoot)
    throw new DownloadError(400, 'asset path escapes the media directory');
  return realTarget;
}

/**
 * Turns a media_assets url into a validated location. Never trusts the string:
 * schemes, hosts, credentials, path traversal and media types are all checked.
 */
export async function resolveAssetUrl(
  raw: string,
  deps: Pick<DownloadDeps, 'assetsDir' | 'allowedHosts'>,
): Promise<AssetLocation> {
  const value = raw.trim();
  if (value.startsWith('local:')) {
    if (!deps.assetsDir) throw new DownloadError(404, 'local assets are not configured');
    const rel = value.slice('local:'.length);
    if (!rel || path.isAbsolute(rel) || /^[a-zA-Z]:[\\/]/.test(rel))
      throw new DownloadError(400, 'local asset paths must be relative');
    const ext = extensionOf(rel);
    const contentType = mediaTypeFor(ext);
    const resolved = await resolveLocal(rel, deps.assetsDir);
    return { kind: 'local', path: resolved, ext, contentType };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DownloadError(400, 'asset url is not a valid URL');
  }
  if (url.protocol === 'file:') {
    if (!deps.assetsDir) throw new DownloadError(404, 'local assets are not configured');
    if (url.host && url.host !== 'localhost')
      throw new DownloadError(400, 'file URLs must be local');
    let filePath: string;
    try {
      filePath = fileURLToPath(url);
    } catch {
      throw new DownloadError(400, 'invalid file URL');
    }
    const ext = extensionOf(filePath);
    const contentType = mediaTypeFor(ext);
    const resolved = await resolveLocal(filePath, deps.assetsDir);
    return { kind: 'local', path: resolved, ext, contentType };
  }
  validateRemote(url, deps);
  const ext = extensionOf(url.pathname);
  return { kind: 'remote', url, ext, contentType: mediaTypeFor(ext) };
}

// ── filename ───────────────────────────────────────────────────────────────

function slug(value: string | null | undefined, max: number): string {
  const s = (value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const dash = cut.lastIndexOf('-');
  return (dash > max / 2 ? cut.slice(0, dash) : cut).replace(/-+$/, '');
}

/** `creator-short-title-video-id.ext`, ASCII only, safe for every filesystem. */
export function downloadFilename(input: {
  creator: string | null;
  title: string | null;
  platformVideoId: string;
  ext: string;
}): string {
  const parts = [
    slug(input.creator, 30),
    slug(input.title, 40),
    slug(input.platformVideoId, 40),
  ].filter((p) => p !== '');
  const base = parts.length ? parts.join('-') : 'video';
  const ext = /^[a-z0-9]{1,8}$/.test(input.ext) ? input.ext : 'bin';
  return `${base}.${ext}`;
}

// ── asset selection ────────────────────────────────────────────────────────

export interface SelectedAsset {
  assetId: string;
  clusterId: string;
  videoId: string;
  url: string;
  kind: string;
  provider: string;
  licenseNote: string | null;
  platform: string;
  platformVideoId: string;
  title: string | null;
  creator: string | null;
}

/**
 * Unexpired assets of the candidate's videos, the representative video's first.
 * `videoId` narrows to one representation.
 */
export async function listAssets(
  db: AnyDatabase,
  clusterId: string,
  options: { videoId?: string | null; now: Date },
): Promise<SelectedAsset[]> {
  const rows = await db
    .select({
      assetId: schema.mediaAssets.id,
      clusterId: schema.videos.clusterId,
      videoId: schema.videos.id,
      url: schema.mediaAssets.url,
      kind: schema.mediaAssets.kind,
      provider: schema.mediaAssets.provider,
      licenseNote: schema.mediaAssets.licenseNote,
      platform: schema.videos.platform,
      platformVideoId: schema.videos.platformVideoId,
      title: schema.videos.title,
      creatorDisplayName: schema.videos.creatorDisplayName,
      creatorHandle: schema.videos.creatorHandle,
    })
    .from(schema.mediaAssets)
    .innerJoin(schema.videos, eq(schema.videos.id, schema.mediaAssets.videoId))
    .innerJoin(schema.clusters, eq(schema.clusters.id, schema.videos.clusterId))
    .where(
      and(
        eq(schema.videos.clusterId, clusterId),
        or(isNull(schema.mediaAssets.expiresAt), gt(schema.mediaAssets.expiresAt, options.now)),
        options.videoId ? eq(schema.videos.id, options.videoId) : undefined,
      ),
    )
    .orderBy(
      desc(sql`${schema.videos.id} = ${schema.clusters.representativeVideoId}`),
      schema.videos.firstDiscoveredAt,
      schema.mediaAssets.createdAt,
      schema.mediaAssets.id,
    );
  return rows.map((r) => ({
    assetId: r.assetId,
    clusterId: r.clusterId ?? clusterId,
    videoId: r.videoId,
    url: r.url,
    kind: r.kind,
    provider: r.provider,
    licenseNote: r.licenseNote,
    platform: r.platform,
    platformVideoId: r.platformVideoId,
    title: r.title,
    creator: r.creatorDisplayName ?? r.creatorHandle,
  }));
}

export type DownloadInfo =
  | {
      available: true;
      assetId: string;
      videoId: string;
      filename: string;
      contentType: string;
      source: 'local' | 'remote';
      provider: string;
      kind: string;
      licenseNote: string | null;
      /** The native <video> element can play it (all served types today). */
      playable: boolean;
      sizeBytes: number | null;
    }
  | { available: false; reason: string };

async function clusterState(
  db: AnyDatabase,
  clusterId: string,
): Promise<'ok' | 'missing' | { mergedInto: string }> {
  if (!UUID.test(clusterId)) return 'missing';
  const [c] = await db
    .select({ id: schema.clusters.id, mergedInto: schema.clusters.mergedIntoClusterId })
    .from(schema.clusters)
    .where(eq(schema.clusters.id, clusterId));
  if (!c) {
    const into = await mergedInto(db, clusterId);
    return into ? { mergedInto: into } : 'missing';
  }
  if (c.mergedInto) return { mergedInto: (await mergedInto(db, clusterId)) ?? c.mergedInto };
  return 'ok';
}

/** First asset of the candidate that passes validation, with its resolved location. */
async function pickAsset(
  deps: DownloadDeps,
  clusterId: string,
  videoId: string | null,
): Promise<{ asset: SelectedAsset; location: AssetLocation }> {
  const now = deps.now?.() ?? new Date();
  const assets = await listAssets(deps.db, clusterId, { videoId, now });
  if (!assets.length) throw new DownloadError(404, UNAVAILABLE_MESSAGE);
  let firstError: DownloadError | null = null;
  for (const asset of assets) {
    try {
      const location = await resolveAssetUrl(asset.url, deps);
      return { asset, location };
    } catch (err) {
      if (err instanceof DownloadError) firstError ??= err;
      else throw err;
    }
  }
  throw firstError ?? new DownloadError(404, UNAVAILABLE_MESSAGE);
}

/**
 * What the UI needs to render Download / Download unavailable and the inline
 * preview, without opening a network connection (local files are stat'ed).
 */
export async function describeDownload(
  deps: DownloadDeps,
  clusterId: string,
  videoId: string | null = null,
): Promise<DownloadInfo> {
  try {
    const state = await clusterState(deps.db, clusterId);
    if (state !== 'ok') throw new DownloadError(404, 'candidate not found');
    const { asset, location } = await pickAsset(deps, clusterId, videoId);
    let sizeBytes: number | null = null;
    if (location.kind === 'local') {
      const s = await stat(location.path);
      if (!s.isFile()) throw new DownloadError(404, 'asset file is missing');
      if (s.size > deps.maxBytes) throw new DownloadError(413, 'asset exceeds the size limit');
      sizeBytes = s.size;
    }
    return {
      available: true,
      assetId: asset.assetId,
      videoId: asset.videoId,
      filename: downloadFilename({
        creator: asset.creator,
        title: asset.title,
        platformVideoId: asset.platformVideoId,
        ext: location.ext,
      }),
      contentType: location.contentType,
      source: location.kind,
      provider: asset.provider,
      kind: asset.kind,
      licenseNote: asset.licenseNote,
      playable: location.contentType.startsWith('video/'),
      sizeBytes,
    };
  } catch (err) {
    if (err instanceof DownloadError) return { available: false, reason: err.message };
    throw err;
  }
}

// ── streaming ──────────────────────────────────────────────────────────────

interface ByteRange {
  start: number;
  end: number;
}

/** Parses a single-range `Range: bytes=…` header; null = whole file; throws 416 when unsatisfiable. */
export function parseRange(header: string | null, size: number): ByteRange | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // ignore multi-range / malformed: serve the whole file
  const [, a, b] = m;
  let start: number;
  let end: number;
  if (a === '' && b === '') return null;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) throw new DownloadError(416, 'range not satisfiable');
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end)
    throw new DownloadError(416, 'range not satisfiable');
  return { start, end };
}

function limitBytes(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) {
          controller.error(new DownloadError(413, 'asset exceeds the size limit'));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

interface Opened {
  status: 200 | 206;
  body: ReadableStream<Uint8Array>;
  contentType: string;
  headers: Record<string, string>;
}

async function openLocal(
  location: Extract<AssetLocation, { kind: 'local' }>,
  rangeHeader: string | null,
  deps: DownloadDeps,
): Promise<Opened> {
  const s = await stat(location.path).catch(() => null);
  if (!s?.isFile()) throw new DownloadError(404, 'asset file is missing');
  if (s.size > deps.maxBytes) throw new DownloadError(413, 'asset exceeds the size limit');
  const range = parseRange(rangeHeader, s.size);
  const headers: Record<string, string> = { 'accept-ranges': 'bytes' };
  if (range) {
    headers['content-range'] = `bytes ${range.start}-${range.end}/${s.size}`;
    headers['content-length'] = String(range.end - range.start + 1);
  } else {
    headers['content-length'] = String(s.size);
  }
  const stream = createReadStream(
    location.path,
    range ? { start: range.start, end: range.end } : {},
  );
  return {
    status: range ? 206 : 200,
    body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
    contentType: location.contentType,
    headers,
  };
}

async function openRemote(
  location: Extract<AssetLocation, { kind: 'remote' }>,
  rangeHeader: string | null,
  deps: DownloadDeps,
): Promise<Opened> {
  const doFetch = deps.fetch ?? fetch;
  // Only what the upstream needs: never the dashboard's cookies or any credential.
  const requestHeaders: Record<string, string> = { accept: 'video/*, application/octet-stream' };
  if (rangeHeader && /^bytes=\d*-\d*$/.test(rangeHeader.trim()))
    requestHeaders['range'] = rangeHeader.trim();
  let url = location.url;
  let upstream: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res: Response;
    try {
      res = await doFetch(url, {
        headers: requestHeaders,
        redirect: 'manual',
        credentials: 'omit',
      });
    } catch {
      throw new DownloadError(502, 'asset host could not be reached');
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      await res.body?.cancel().catch(() => undefined);
      const next = res.headers.get('location');
      if (!next || hop === MAX_REDIRECTS)
        throw new DownloadError(502, 'asset host redirected too many times');
      let target: URL;
      try {
        target = new URL(next, url);
      } catch {
        throw new DownloadError(502, 'asset host returned an invalid redirect');
      }
      // A redirect must satisfy exactly the same rules as the stored URL (no SSRF via Location).
      url = validateRemote(target, deps);
      continue;
    }
    upstream = res;
    break;
  }
  if (!upstream) throw new DownloadError(502, 'asset host did not respond');
  if (upstream.status !== 200 && upstream.status !== 206) {
    await upstream.body?.cancel().catch(() => undefined);
    throw new DownloadError(
      upstream.status === 404 ? 404 : 502,
      upstream.status === 404
        ? 'asset file is missing upstream'
        : `asset host answered ${upstream.status}`,
    );
  }
  const upstreamType = (upstream.headers.get('content-type') ?? '')
    .split(';')[0]
    ?.trim()
    .toLowerCase();
  let contentType = location.contentType;
  if (upstreamType && ALLOWED_CONTENT_TYPES.has(upstreamType)) contentType = upstreamType;
  else if (upstreamType && !GENERIC_CONTENT_TYPES.has(upstreamType)) {
    await upstream.body?.cancel().catch(() => undefined);
    throw new DownloadError(415, `asset host served unsupported media type "${upstreamType}"`);
  }
  const length = upstream.headers.get('content-length');
  const headers: Record<string, string> = {};
  const declared = length !== null && /^\d+$/.test(length) ? Number(length) : null;
  if (declared !== null) {
    if (declared > deps.maxBytes) {
      await upstream.body?.cancel().catch(() => undefined);
      throw new DownloadError(413, 'asset exceeds the size limit');
    }
    headers['content-length'] = String(declared);
  }
  if (upstream.status === 206) {
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) headers['content-range'] = contentRange;
  }
  if (upstream.headers.get('accept-ranges') === 'bytes') headers['accept-ranges'] = 'bytes';
  if (!upstream.body) throw new DownloadError(502, 'asset host sent no body');
  const body = declared === null ? limitBytes(upstream.body, deps.maxBytes) : upstream.body;
  return { status: upstream.status === 206 ? 206 : 200, body, contentType, headers };
}

function errorResponse(err: DownloadError): Response {
  return new Response(JSON.stringify({ error: err.message }), {
    status: err.status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * GET /api/candidates/:clusterId/download (mode "download": attachment, records
 * "obtained") and /media (mode "inline": for the native player, records nothing).
 * Optional `?video=<videoId>` picks one representation.
 */
export async function handleMediaRequest(
  deps: DownloadDeps,
  request: Request,
  clusterId: string,
  mode: 'download' | 'inline',
): Promise<Response> {
  try {
    const params = new URL(request.url).searchParams;
    const videoParam = params.get('video');
    if (videoParam !== null && !UUID.test(videoParam))
      throw new DownloadError(400, 'invalid video id');
    const state = await clusterState(deps.db, clusterId);
    if (state === 'missing') throw new DownloadError(404, 'candidate not found');
    if (state !== 'ok') {
      const target = new URL(request.url);
      target.pathname = target.pathname.replace(clusterId, state.mergedInto);
      return Response.redirect(target.toString(), 307);
    }
    const { asset, location } = await pickAsset(deps, clusterId, videoParam);
    const rangeHeader = request.headers.get('range');
    const opened =
      location.kind === 'local'
        ? await openLocal(location, rangeHeader, deps)
        : await openRemote(location, rangeHeader, deps);
    const filename = downloadFilename({
      creator: asset.creator,
      title: asset.title,
      platformVideoId: asset.platformVideoId,
      ext: location.ext,
    });
    const headers = new Headers({
      ...opened.headers,
      'content-type': opened.contentType,
      'content-disposition': `${mode === 'download' ? 'attachment' : 'inline'}; filename="${filename}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    });
    if (mode === 'download') {
      // The file is on its way: that is the acquisition. Never recorded for a missing/invalid asset.
      try {
        await recordAcquisition(deps.db, {
          clusterId,
          status: 'obtained',
          videoId: asset.videoId,
          note: `Downloaded via dashboard (${asset.kind} from ${asset.provider})`,
          now: deps.now?.() ?? new Date(),
        });
      } catch (err) {
        deps.logger?.error({ err, clusterId }, 'download served but acquisition not recorded');
      }
    }
    return new Response(opened.body, { status: opened.status, headers });
  } catch (err) {
    if (err instanceof DownloadError) return errorResponse(err);
    deps.logger?.error({ err, clusterId }, 'media download failed');
    return errorResponse(new DownloadError(500, 'download failed'));
  }
}
