import { pino } from 'pino';
import type { AdapterContext } from '../adapter.ts';
import type { FetchLike } from '../http.ts';
import { createInMemoryQuotaBudget } from '../quota.ts';

export interface FakeResponse {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface RecordedRequest {
  url: URL;
  method: string;
  headers: Headers;
  body: string | null;
}

/** A route answers requests whose URL matches `match`; responses are consumed in order, the last one repeats. */
export interface FakeRoute {
  match: (url: URL, method: string) => boolean;
  responses: FakeResponse[];
}

/**
 * A scripted fetch() for adapter tests: no network access, every request is
 * recorded, and unmatched requests fail loudly.
 */
export function createFakeFetch(routes: FakeRoute[]): FetchLike & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const counters = new Map<FakeRoute, number>();
  const fake = (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    requests.push({
      url,
      method,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    const route = routes.find((r) => r.match(url, method));
    if (!route) return Promise.reject(new Error(`fake fetch: no route for ${method} ${url.href}`));
    const n = counters.get(route) ?? 0;
    counters.set(route, n + 1);
    const response = route.responses[Math.min(n, route.responses.length - 1)];
    if (!response) return Promise.reject(new Error(`fake fetch: route has no responses`));
    return Promise.resolve(
      new Response(
        typeof response.body === 'string' ? response.body : JSON.stringify(response.body),
        {
          status: response.status ?? 200,
          headers: { 'content-type': 'application/json', ...response.headers },
        },
      ),
    );
  };
  return Object.assign(fake, { requests });
}

/** Route helper: matches on URL path (and optionally a predicate on the query). */
export function route(
  path: string | RegExp,
  responses: FakeResponse | FakeResponse[],
  where: (url: URL) => boolean = () => true,
): FakeRoute {
  return {
    match: (url) =>
      (typeof path === 'string' ? url.pathname === path : path.test(url.pathname)) && where(url),
    responses: Array.isArray(responses) ? responses : [responses],
  };
}

export function testAdapterContext(
  options: { now?: Date; limits?: Record<string, number>; signal?: AbortSignal } = {},
): AdapterContext {
  const now = options.now ?? new Date('2026-09-28T12:00:00Z');
  return {
    logger: pino({ level: 'silent' }),
    signal: options.signal ?? new AbortController().signal,
    quota: createInMemoryQuotaBudget(options.limits ?? {}),
    now: () => now,
  };
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}
