/**
 * Expands TikTok short/share links (e.g. https://www.tiktok.com/t/ZTyUGaVNb/,
 * https://vm.tiktok.com/…) into canonical video identities.
 *
 * This is deliberately NOT a generic redirect follower:
 *  - only HTTPS URLs on an explicit allowlist of TikTok hosts are ever requested;
 *  - every Location is validated BEFORE it could be requested;
 *  - it stops at the first Location that is a canonical video URL, so video
 *    pages themselves are never requested;
 *  - HEAD requests, no cookies/credentials, bodies are never read;
 *  - bounded hops, loop detection, and a total timeout.
 * Observed 2026-09-29: /t/ links answer HEAD with a single 301 to
 * https://www.tiktok.com/@user/video/<id>?….
 */
import { resolveVideoUrl, type ResolvedVideoUrl } from '@vd/url-identity';

/** Hosts that may be requested at all (start and every hop). */
export const TIKTOK_REDIRECT_HOSTS: ReadonlySet<string> = new Set([
  'www.tiktok.com',
  'tiktok.com',
  'm.tiktok.com',
  'vm.tiktok.com',
  'vt.tiktok.com',
]);

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface ShortLinkOptions {
  fetch?: FetchLike;
  /** Redirect responses followed before giving up (default 3). */
  maxRedirects?: number;
  /** Total budget for all hops (default 5 s). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type ShortLinkFailure =
  | 'not_short_link' // input is not a recognized TikTok short link
  | 'unexpected_host' // a redirect left the TikTok allowlist (or scheme/port/credentials changed)
  | 'bad_location' // missing or unparseable Location header
  | 'redirect_loop'
  | 'too_many_redirects'
  | 'not_a_video' // redirected to something that is not a TikTok video (homepage, profile, photo)
  | 'no_redirect' // 2xx: TikTok did not redirect
  | 'http_error' // 4xx/5xx
  | 'network'
  | 'timeout';

export type ShortLinkResult =
  | { ok: true; resolved: ResolvedVideoUrl; hops: string[] }
  | { ok: false; reason: ShortLinkFailure; message: string; hops: string[] };

/** Scheme + host + path of a URL, without query/fragment (safe to log/store). */
function describe(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

function allowed(url: URL): boolean {
  return (
    url.protocol === 'https:' &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    TIKTOK_REDIRECT_HOSTS.has(url.hostname.toLowerCase())
  );
}

/** True when the pure resolver identifies `input` as a TikTok short link we may expand. */
export function isTikTokShortLink(input: string): boolean {
  const r = resolveVideoUrl(input);
  return !r.ok && r.reason === 'short_link' && r.platform === 'tiktok';
}

export async function expandTikTokShortLink(
  input: string,
  options: ShortLinkOptions = {},
): Promise<ShortLinkResult> {
  const hops: string[] = [];
  const fail = (reason: ShortLinkFailure, message: string): ShortLinkResult => ({
    ok: false,
    reason,
    message,
    hops,
  });

  if (!isTikTokShortLink(input))
    return fail('not_short_link', 'not a recognized TikTok short link');
  let current: URL;
  try {
    current = new URL(
      /^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`,
    );
  } catch {
    return fail('not_short_link', 'not a URL');
  }
  // Short links are always requested over HTTPS.
  if (current.protocol === 'http:') current.protocol = 'https:';
  if (!allowed(current)) return fail('unexpected_host', `host not allowed: ${current.hostname}`);

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const maxRedirects = options.maxRedirects ?? 3;
  const signals = [AbortSignal.timeout(options.timeoutMs ?? 5_000)];
  if (options.signal) signals.push(options.signal);
  const signal = AbortSignal.any(signals);
  const visited = new Set<string>([current.href]);

  for (let redirects = 0; ; redirects++) {
    hops.push(describe(current));
    let response: Response;
    try {
      response = await fetchImpl(current, {
        method: 'HEAD',
        redirect: 'manual',
        credentials: 'omit',
        headers: { Accept: '*/*' },
        signal,
      });
    } catch (err) {
      const timedOut =
        err instanceof Error &&
        (err.name === 'TimeoutError' || (err.name === 'AbortError' && signal.aborted));
      return fail(
        timedOut ? 'timeout' : 'network',
        `${timedOut ? 'timed out' : 'request failed'} at ${describe(current)}`,
      );
    }
    // Never read a body.
    await response.body?.cancel().catch(() => undefined);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location)
        return fail('bad_location', `HTTP ${response.status} without a Location header`);
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return fail('bad_location', 'unparseable Location header');
      }
      if (!allowed(next)) {
        return fail(
          'unexpected_host',
          `redirect to a non-allowlisted destination: ${next.protocol}//${next.host}`,
        );
      }
      if (visited.has(next.href))
        return fail('redirect_loop', `redirect loop at ${describe(next)}`);
      visited.add(next.href);

      const identity = resolveVideoUrl(next.href);
      if (identity.ok) {
        if (identity.platform !== 'tiktok') return fail('unexpected_host', 'redirected off TikTok');
        hops.push(describe(next));
        return { ok: true, resolved: identity, hops };
      }
      if (identity.reason !== 'short_link') {
        return fail('not_a_video', `redirected to a non-video page: ${describe(next)}`);
      }
      if (redirects + 1 >= maxRedirects) {
        return fail('too_many_redirects', `more than ${maxRedirects} redirects`);
      }
      current = next;
      continue;
    }
    if (response.status >= 200 && response.status < 300) {
      return fail('no_redirect', `HTTP ${response.status} without a redirect`);
    }
    return fail('http_error', `HTTP ${response.status} from ${describe(current)}`);
  }
}
