/**
 * The ONLY network path in near-duplicate detection: fetching a thumbnail image
 * so it can be perceptually hashed. Source video media is never requested.
 *
 * SSRF defenses, all enforced on every hop (including redirects):
 *  - https only, default port only, no userinfo, no IP-literal hosts;
 *  - host must be a known adapter thumbnail CDN (allowlist);
 *  - DNS answers are checked at CONNECT time (custom lookup), so a name that
 *    resolves to a loopback/private/link-local/reserved address is refused even
 *    if it passed the name check (no DNS-rebinding window);
 *  - redirects are followed manually (max 3) and re-validated;
 *  - no cookies, no Authorization/credential headers are ever sent;
 *  - bounded body size (streaming cutoff), image content-type required, overall timeout.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { isIP } from 'node:net';

/** Thumbnail CDNs our adapters emit (suffix match on DNS labels). */
export const TRUSTED_THUMBNAIL_HOSTS = [
  'ytimg.com', // YouTube
  'ggpht.com', // YouTube (channel/legacy thumbnails)
  'jtvnw.net', // Twitch static CDN
  'twitch.tv', // Twitch clip thumbnails (clips-media-assets2.twitch.tv)
  'tiktokcdn.com', // TikTok oEmbed thumbnails
  'tiktokcdn-us.com',
  'tiktokcdn-eu.com',
  'ibyteimg.com',
  'bsky.app', // Bluesky CDN (cdn.bsky.app / video.bsky.app thumbnails)
] as const;

export interface FetchPolicy {
  allowedHosts: readonly string[];
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
}

export const DEFAULT_FETCH_POLICY: FetchPolicy = {
  allowedHosts: TRUSTED_THUMBNAIL_HOSTS,
  maxBytes: 2_000_000,
  timeoutMs: 6_000,
  maxRedirects: 3,
};

export type FetchFailure =
  | 'rejected_url'
  | 'host_not_allowed'
  | 'blocked_address'
  | 'http_error'
  | 'not_an_image'
  | 'unsupported_format'
  | 'too_large'
  | 'too_many_redirects'
  | 'timeout'
  | 'fetch_failed';

export type FetchResult =
  | { ok: true; bytes: Uint8Array; contentType: string; finalUrl: string }
  | { ok: false; status: FetchFailure; reason: string };

export function hostAllowed(hostname: string, allowed: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return allowed.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export function checkThumbnailUrl(
  raw: string,
  policy: Pick<FetchPolicy, 'allowedHosts'> = DEFAULT_FETCH_POLICY,
):
  | { ok: true; url: URL }
  | { ok: false; status: 'rejected_url' | 'host_not_allowed'; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, status: 'rejected_url', reason: 'not a URL' };
  }
  if (url.protocol !== 'https:') return { ok: false, status: 'rejected_url', reason: 'not https' };
  if (url.username || url.password)
    return { ok: false, status: 'rejected_url', reason: 'credentials in URL' };
  if (url.port && url.port !== '443')
    return { ok: false, status: 'rejected_url', reason: 'non-default port' };
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0) return { ok: false, status: 'rejected_url', reason: 'IP-literal host' };
  if (!hostAllowed(host, policy.allowedHosts))
    return {
      ok: false,
      status: 'host_not_allowed',
      reason: `host ${host} is not a known thumbnail CDN`,
    };
  return { ok: true, url };
}

function ipv4Public(ip: string): boolean {
  const [a = 0, b = 0, c = 0] = ip.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this-net, private, loopback, multicast/reserved
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF / TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  return true;
}

/** True only for globally routable unicast addresses. */
export function isPublicAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return ipv4Public(address);
  if (kind !== 6) return false;
  const ip = address.toLowerCase();
  const mapped =
    /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip) ?? /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped?.[1]) return ipv4Public(mapped[1]);
  if (ip === '::' || ip === '::1') return false;
  const first = parseInt(ip.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (ip.startsWith('2001:db8:') || ip.startsWith('2001:0db8:')) return false; // documentation
  if (ip.startsWith('100::') || /^0*:/.test(ip)) return false; // discard / IPv4-compatible
  return true;
}

export class BlockedAddressError extends Error {
  readonly code = 'EBLOCKED';
  constructor(host: string, address: string) {
    super(`${host} resolves to a non-public address (${address})`);
    this.name = 'BlockedAddressError';
  }
}

type Resolver = (
  hostname: string,
  options: { all: true },
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/**
 * A `lookup` for https.request that refuses unless EVERY resolved address is
 * public, then connects to the first one — the check happens on the exact
 * answer used for the connection.
 */
export function safeLookup(resolver: Resolver = dnsLookup) {
  return (
    hostname: string,
    options: unknown,
    callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void,
  ) => {
    resolver(hostname, { all: true }, (err, addresses) => {
      if (err) {
        callback(err, '', 4);
        return;
      }
      const blocked = addresses.find((a) => !isPublicAddress(a.address));
      if (blocked !== undefined || addresses.length === 0) {
        callback(new BlockedAddressError(hostname, blocked?.address ?? 'none'), '', 4);
        return;
      }
      const wantsAll =
        typeof options === 'object' && options !== null && (options as { all?: boolean }).all;
      const [first] = addresses;
      if (wantsAll) callback(null, addresses);
      else if (first) callback(null, first.address, first.family);
    });
  };
}

export interface HopResponse {
  status: number;
  location: string | null;
  contentType: string | null;
  contentLength: number | null;
  body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  /** Stops reading and closes the connection. */
  destroy: () => void;
}

/** One HTTP GET without following redirects. Injectable for tests. */
export type HopTransport = (url: URL, signal: AbortSignal) => Promise<HopResponse>;

export const httpsTransport: HopTransport = (url, signal) =>
  new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'GET',
        // Fresh connection per request: no pooled sockets, no cookies, no credentials.
        agent: false,
        lookup: safeLookup(),
        signal,
        headers: {
          accept: 'image/jpeg,image/png;q=0.9',
          'user-agent': 'viral-discovery-thumbnail-hash/1.0',
        },
      },
      (res) => {
        const len = Number(res.headers['content-length']);
        resolve({
          status: res.statusCode ?? 0,
          location: typeof res.headers.location === 'string' ? res.headers.location : null,
          contentType: res.headers['content-type'] ?? null,
          contentLength: Number.isFinite(len) ? len : null,
          body: res,
          destroy: () => res.destroy(),
        });
      },
    );
    req.on('error', reject);
    req.end();
  });

function classify(err: unknown): { status: FetchFailure; reason: string } {
  if (err instanceof BlockedAddressError) return { status: 'blocked_address', reason: err.message };
  const cause = err instanceof Error ? (err.cause ?? err) : err;
  if (cause instanceof BlockedAddressError)
    return { status: 'blocked_address', reason: cause.message };
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'))
    return { status: 'timeout', reason: 'timed out' };
  return {
    status: 'fetch_failed',
    reason: err instanceof Error ? err.message.slice(0, 200) : 'request failed',
  };
}

export async function fetchThumbnail(
  raw: string,
  options: { policy?: FetchPolicy; transport?: HopTransport } = {},
): Promise<FetchResult> {
  const policy = options.policy ?? DEFAULT_FETCH_POLICY;
  const transport = options.transport ?? httpsTransport;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException('timed out', 'TimeoutError'));
  }, policy.timeoutMs);
  try {
    let current = raw;
    for (let hop = 0; hop <= policy.maxRedirects; hop++) {
      const checked = checkThumbnailUrl(current, policy);
      if (!checked.ok) return checked;
      const res = await transport(checked.url, controller.signal);
      if (res.status >= 300 && res.status < 400 && res.location) {
        res.destroy();
        current = new URL(res.location, checked.url).href;
        continue;
      }
      if (res.status !== 200) {
        res.destroy();
        return { ok: false, status: 'http_error', reason: `HTTP ${res.status}` };
      }
      const type = (res.contentType ?? '').replace(/;.*$/, '').trim().toLowerCase();
      if (!type.startsWith('image/')) {
        res.destroy();
        return { ok: false, status: 'not_an_image', reason: `content-type ${type || 'missing'}` };
      }
      if (type !== 'image/jpeg' && type !== 'image/jpg' && type !== 'image/png') {
        res.destroy();
        return { ok: false, status: 'unsupported_format', reason: `content-type ${type}` };
      }
      if (res.contentLength !== null && res.contentLength > policy.maxBytes) {
        res.destroy();
        return { ok: false, status: 'too_large', reason: `declared ${res.contentLength} bytes` };
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of res.body) {
        size += chunk.byteLength;
        if (size > policy.maxBytes) {
          res.destroy();
          return { ok: false, status: 'too_large', reason: `exceeded ${policy.maxBytes} bytes` };
        }
        chunks.push(chunk);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.byteLength;
      }
      return { ok: true, bytes, contentType: type, finalUrl: checked.url.href };
    }
    return {
      ok: false,
      status: 'too_many_redirects',
      reason: `more than ${policy.maxRedirects} redirects`,
    };
  } catch (err) {
    return {
      ok: false,
      ...(controller.signal.aborted ? { status: 'timeout', reason: 'timed out' } : classify(err)),
    };
  } finally {
    clearTimeout(timer);
  }
}
