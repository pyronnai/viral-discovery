/**
 * An in-memory TikTokPublicProvider for tests (no network). Imported only by tests.
 */
import type {
  TikTokProviderCallContext,
  TikTokProviderError,
  TikTokPublicPost,
  TikTokPublicProvider,
} from './provider.ts';

export interface FakeTikTokProvider extends TikTokPublicProvider {
  calls: { op: 'search' | 'lookup'; input: unknown }[];
}

export function createFakeTikTokProvider(
  posts: readonly TikTokPublicPost[],
  options: { errors?: TikTokProviderError[]; fail?: Error; maxLookupBatch?: number } = {},
): FakeTikTokProvider {
  const calls: FakeTikTokProvider['calls'] = [];
  const respond = (ctx: TikTokProviderCallContext) => {
    ctx.meter.request();
    if (options.fail) throw options.fail;
  };
  return {
    id: 'fake',
    displayName: 'fake test source',
    accessMethod: 'official_api',
    maxLookupBatch: options.maxLookupBatch ?? 100,
    calls,
    searchPosts(query, ctx) {
      calls.push({ op: 'search', input: query });
      respond(ctx);
      return Promise.resolve({
        posts: posts.slice(0, query.limit),
        errors: options.errors ?? [],
      });
    },
    lookupPosts(urls, ctx) {
      calls.push({ op: 'lookup', input: [...urls] });
      respond(ctx);
      const ids = new Set(urls.map((u) => /\/video\/(\d+)/.exec(u)?.[1]));
      return Promise.resolve({ posts: posts.filter((p) => ids.has(p.videoId)), errors: [] });
    },
  };
}
