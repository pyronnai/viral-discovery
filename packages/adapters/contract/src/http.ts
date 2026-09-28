/**
 * Minimal JSON-over-HTTP helper shared by adapters. It maps HTTP failures to
 * typed UpstreamErrors and never puts query strings (which could contain
 * credentials) into error messages.
 */

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type UpstreamErrorKind =
  | 'rate_limited' // 429 or a platform-specific rate-limit signal
  | 'quota_exceeded' // daily/project quota exhausted
  | 'unauthorized' // 401: missing/expired/invalid credentials
  | 'forbidden' // 403 not otherwise classified
  | 'not_found'
  | 'bad_request'
  | 'server_error'
  | 'network' // DNS, connection reset, …
  | 'timeout'
  | 'invalid_response'; // 2xx, but not the JSON shape we expected

export class UpstreamError extends Error {
  readonly service: string;
  readonly kind: UpstreamErrorKind;
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;
  /** Parsed error body when the service returned JSON; never includes our credentials. */
  readonly body: unknown;

  constructor(
    service: string,
    kind: UpstreamErrorKind,
    message: string,
    options: {
      status?: number;
      retryAfterSeconds?: number | null;
      body?: unknown;
      cause?: unknown;
    } = {},
  ) {
    super(`${service}: ${message}`, options.cause === undefined ? {} : { cause: options.cause });
    this.name = 'UpstreamError';
    this.service = service;
    this.kind = kind;
    this.status = options.status ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.body = options.body;
  }
}

export interface RequestJsonOptions {
  service: string;
  fetch: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
  init?: RequestInit;
  /**
   * Refines a non-2xx response into a more specific kind/detail, e.g. YouTube
   * reports quota exhaustion as 403 with reason "quotaExceeded".
   */
  classify?: (
    status: number,
    body: unknown,
  ) => { kind?: UpstreamErrorKind; detail?: string } | undefined;
  /** Platform-specific retry hint (e.g. Twitch's Ratelimit-Reset epoch). Falls back to Retry-After. */
  retryAfter?: (headers: Headers) => number | null;
}

/** Scheme, host, and path only — safe to log. */
export function describeUrl(url: string | URL): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '(invalid url)';
  }
}

function kindForStatus(status: number): UpstreamErrorKind {
  if (status === 429) return 'rate_limited';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server_error';
  return 'bad_request';
}

function retryAfter(headers: Headers): number | null {
  const value = headers.get('retry-after');
  if (value === null) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

export async function requestJson(
  url: string | URL,
  options: RequestJsonOptions,
): Promise<unknown> {
  const { service } = options;
  const where = describeUrl(url);
  const signals = [AbortSignal.timeout(options.timeoutMs ?? 15_000)];
  if (options.signal) signals.push(options.signal);

  let response: Response;
  try {
    response = await options.fetch(url, { ...options.init, signal: AbortSignal.any(signals) });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    throw new UpstreamError(
      service,
      timedOut ? 'timeout' : 'network',
      `${timedOut ? 'timed out' : 'request failed'} for ${where}`,
      { cause: err },
    );
  }

  const text = await response.text();
  let body: unknown = undefined;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }

  if (!response.ok) {
    const refined = options.classify?.(response.status, body);
    const detail = refined?.detail ? ` (${refined.detail})` : '';
    throw new UpstreamError(
      service,
      refined?.kind ?? kindForStatus(response.status),
      `HTTP ${response.status} for ${where}${detail}`,
      {
        status: response.status,
        retryAfterSeconds: options.retryAfter?.(response.headers) ?? retryAfter(response.headers),
        body,
      },
    );
  }
  if (body === undefined) {
    throw new UpstreamError(service, 'invalid_response', `non-JSON response from ${where}`, {
      status: response.status,
    });
  }
  return body;
}
