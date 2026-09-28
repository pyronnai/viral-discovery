import { z } from 'zod';
import {
  AdapterManifestSchema,
  UpstreamError,
  consumeQuota,
  parseParams,
  requestJson,
  stringList,
  type AdapterContext,
  type DiscoveryRequest,
  type FetchLike,
  type MetricRefreshResult,
  type NormalizedVideo,
  type RawItem,
  type SourceAdapter,
  type VideoRef,
} from '@vd/adapter-contract';
import { buildReadings, metricUnavailable, metricValue, type MetricReadings } from '@vd/core';
import { resolveVideoUrl, type ResolvedVideoUrl } from '@vd/url-identity';
import { expandTikTokShortLink, isTikTokShortLink, type ShortLinkResult } from '@vd/url-resolution';

export const BLUESKY_ADAPTER_ID = 'bluesky';
const SERVICE = 'bluesky';
/**
 * Bluesky AppView without authentication. Bluesky documents both api.bsky.app and
 * public.api.bsky.app as unauthenticated; on 2026-09-28 searchPosts returned 403
 * from public.api.bsky.app (cached host) and 200 from api.bsky.app.
 */
export const DEFAULT_APPVIEW = 'https://api.bsky.app';
/** app.bsky.feed.getPosts accepts at most 25 uris (lexicon, verified 2026-09-28). */
export const GET_POSTS_MAX = 25;

export const manifest = AdapterManifestSchema.parse({
  id: BLUESKY_ADAPTER_ID,
  platform: 'bluesky',
  displayName: 'Bluesky AppView (public search)',
  version: '1.0.0',
  accessMethod: 'official_api',
  capabilities: ['discovery.search', 'metrics.refresh', 'normalize'],
  // Only for native Bluesky videos. Engagement on a post that links elsewhere is never a video metric.
  metricsProvided: ['likes', 'comments'],
  referencePlatforms: ['youtube', 'tiktok', 'twitch'],
  quotaBuckets: [
    {
      name: 'default',
      unit: 'requests',
      defaultDailyBudget: null,
      notes: 'AppView limits are described as "generous" and not published',
    },
    {
      name: 'tiktok-shortlink',
      unit: 'expansions',
      defaultDailyBudget: null,
      notes: 'TikTok share links found in posts, expanded via allowlisted HEAD redirects',
    },
  ],
  requiredEnv: [],
  docsPath: 'docs/sources/bluesky.md',
});

export const SearchParamsSchema = z.object({
  q: z.string().trim().min(1, 'a search query is required'),
  sort: z.enum(['latest', 'top']).default('latest'),
  since: z.string().min(1).optional(),
  until: z.string().min(1).optional(),
  lang: z.string().min(2).optional(),
  /** Only posts linking to this host, e.g. "youtube.com" (server-side filter). */
  domain: z.string().min(1).optional(),
  author: z.string().min(1).optional(),
  tag: stringList(z.string().min(1)).optional(),
  /** Page size for searchPosts (1–100). */
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  pages: z.coerce.number().int().min(1).max(10).default(1),
  /** Which candidates to emit: native Bluesky videos, links to supported platforms, or both. */
  include: z.enum(['both', 'native', 'links']).default('both'),
});
export type SearchParams = z.infer<typeof SearchParamsSchema>;

const Author = z.object({
  did: z.string().min(1),
  handle: z.string().min(1),
  displayName: z.string().optional(),
});
const ExternalView = z.object({
  $type: z.literal('app.bsky.embed.external#view'),
  external: z.object({ uri: z.string(), title: z.string().optional() }),
});
const VideoView = z.object({
  $type: z.literal('app.bsky.embed.video#view'),
  cid: z.string(),
  thumbnail: z.string().optional(),
});
const RecordWithMediaView = z.object({
  $type: z.literal('app.bsky.embed.recordWithMedia#view'),
  media: z.unknown(),
});
const Facet = z.object({
  features: z.array(z.object({ $type: z.string(), uri: z.string().optional() })).default([]),
});

export const PostView = z.object({
  uri: z.string().regex(/^at:\/\/[^/]+\/app\.bsky\.feed\.post\/[^/]+$/, 'not a post AT-URI'),
  cid: z.string(),
  author: Author,
  record: z.object({
    text: z.string().optional(),
    createdAt: z.string().optional(),
    langs: z.array(z.string()).optional(),
    facets: z.array(Facet).optional(),
  }),
  embed: z.unknown().optional(),
  likeCount: z.number().int().nonnegative().optional(),
  replyCount: z.number().int().nonnegative().optional(),
  repostCount: z.number().int().nonnegative().optional(),
  quoteCount: z.number().int().nonnegative().optional(),
  indexedAt: z.string(),
});
export type PostView = z.infer<typeof PostView>;

const SearchResponse = z.object({
  posts: z.array(z.unknown()),
  cursor: z.string().optional(),
});
const GetPostsResponse = z.object({ posts: z.array(z.unknown()) });

/** What an item is: a Bluesky-native video, or a link to a video on another platform. */
const Payload = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('native'), post: PostView }),
  z.object({
    kind: z.literal('link'),
    post: PostView,
    url: z.string(),
    /** Canonical URL after expanding a short link (TikTok /t/, vm., vt.). */
    resolvedUrl: z.string().optional(),
    /** Why a short link could not be expanded; the item is quarantined. */
    expansionError: z.string().optional(),
  }),
]);

export interface BlueskyAdapterOptions {
  fetch?: FetchLike;
  appviewUrl?: string;
  /** Expand TikTok short links found in posts (default true). */
  expandShortLinks?: boolean;
}

/** at://did/app.bsky.feed.post/rkey → https://bsky.app/profile/did/post/rkey */
export function postWebUrl(atUri: string): string {
  const [, , did, , rkey] = atUri.split('/');
  return `https://bsky.app/profile/${did ?? ''}/post/${rkey ?? ''}`;
}

function nativeVideo(embed: unknown): z.infer<typeof VideoView> | null {
  const direct = VideoView.safeParse(embed);
  if (direct.success) return direct.data;
  const wrapped = RecordWithMediaView.safeParse(embed);
  if (wrapped.success) {
    const media = VideoView.safeParse(wrapped.data.media);
    if (media.success) return media.data;
  }
  return null;
}

function externalEmbed(embed: unknown): z.infer<typeof ExternalView>['external'] | null {
  const direct = ExternalView.safeParse(embed);
  if (direct.success) return direct.data.external;
  const wrapped = RecordWithMediaView.safeParse(embed);
  if (wrapped.success) {
    const media = ExternalView.safeParse(wrapped.data.media);
    if (media.success) return media.data.external;
  }
  return null;
}

function postUrls(post: PostView): string[] {
  const urls: string[] = [];
  const card = externalEmbed(post.embed);
  if (card) urls.push(card.uri);
  for (const facet of post.record.facets ?? []) {
    for (const feature of facet.features) {
      if (feature.$type === 'app.bsky.richtext.facet#link' && feature.uri) urls.push(feature.uri);
    }
  }
  return urls;
}

/** Short links in a post that need network expansion before they have an identity. */
export function shortLinks(post: PostView): string[] {
  return [...new Set(postUrls(post).filter(isTikTokShortLink))];
}

/** Every supported video a post links to (link card + rich-text links), once per identity. */
export function linkedVideos(post: PostView): { url: string; resolved: ResolvedVideoUrl }[] {
  const urls = postUrls(post);
  const seen = new Set<string>();
  const out: { url: string; resolved: ResolvedVideoUrl }[] = [];
  for (const url of urls) {
    const resolved = resolveVideoUrl(url);
    if (!resolved.ok) continue;
    const key = `${resolved.platform}:${resolved.platformVideoId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url, resolved });
  }
  return out;
}

function postContext(post: PostView, query: string) {
  return {
    query,
    postUri: post.uri,
    postUrl: postWebUrl(post.uri),
    postCid: post.cid,
    postAuthor: {
      did: post.author.did,
      handle: post.author.handle,
      displayName: post.author.displayName ?? null,
    },
    postCreatedAt: post.record.createdAt ?? null,
    postIndexedAt: post.indexedAt,
    // Engagement of the *post* at observation time — evidence of spread, not video metrics.
    postEngagement: {
      likes: post.likeCount ?? null,
      reposts: post.repostCount ?? null,
      replies: post.replyCount ?? null,
      quotes: post.quoteCount ?? null,
    },
  };
}

/** likes = likeCount, comments = replyCount. Reposts/quotes stay in context, not "shares". */
function postMetrics(post: PostView): MetricReadings {
  const count = (v: number | undefined) =>
    v === undefined ? metricUnavailable('unknown') : metricValue(v);
  return buildReadings({ likes: count(post.likeCount), comments: count(post.replyCount) });
}

function date(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function createBlueskyAdapter(options: BlueskyAdapterOptions = {}): SourceAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const expandShortLinks = options.expandShortLinks ?? true;
  const appview = (options.appviewUrl ?? DEFAULT_APPVIEW).replace(/\/+$/, '');

  async function xrpc(method: string, query: URLSearchParams, ctx: AdapterContext) {
    consumeQuota(ctx.quota, 'default');
    const url = new URL(`${appview}/xrpc/${method}`);
    url.search = query.toString();
    return requestJson(url, {
      service: SERVICE,
      fetch: fetchImpl,
      signal: ctx.signal,
      init: { headers: { Accept: 'application/json' } },
      classify: (status, body) => {
        const detail =
          typeof body === 'object' &&
          body !== null &&
          'message' in body &&
          typeof body.message === 'string'
            ? body.message
            : undefined;
        if (status === 401 || status === 403) {
          return {
            kind: 'forbidden',
            detail: `${detail ?? 'refused'}; this AppView host may require authentication for ${method}`,
          };
        }
        return detail ? { detail } : undefined;
      },
    });
  }

  return {
    manifest,

    async *discoverSearch(req: DiscoveryRequest, ctx: AdapterContext) {
      const params = parseParams(BLUESKY_ADAPTER_ID, SearchParamsSchema, req.params);
      const base = new URLSearchParams({
        q: params.q,
        sort: params.sort,
        limit: String(params.pageSize),
      });
      for (const key of ['since', 'until', 'lang', 'domain', 'author'] as const) {
        const value = params[key];
        if (value) base.set(key, value);
      }
      for (const tag of params.tag ?? []) base.append('tag', tag);

      let cursor: string | undefined;
      let yielded = 0;
      let rank = 0;
      // One expansion per distinct short link per run.
      const expansions = new Map<string, ShortLinkResult>();
      const expand = async (url: string) => {
        let result = expansions.get(url);
        if (!result) {
          consumeQuota(ctx.quota, 'tiktok-shortlink');
          result = await expandTikTokShortLink(url, { fetch: fetchImpl, signal: ctx.signal });
          expansions.set(url, result);
        }
        return result;
      };
      for (let page = 1; page <= params.pages; page++) {
        if (ctx.signal.aborted || yielded >= req.limit) return;
        const query = new URLSearchParams(base);
        if (cursor) query.set('cursor', cursor);
        const body = SearchResponse.safeParse(await xrpc('app.bsky.feed.searchPosts', query, ctx));
        if (!body.success) {
          throw new UpstreamError(
            SERVICE,
            'invalid_response',
            'searchPosts response has no posts array',
          );
        }
        const fetchedAt = ctx.now();
        for (const item of body.data.posts) {
          rank += 1;
          const post = PostView.safeParse(item);
          if (!post.success) {
            // Surface malformed posts to the pipeline (quarantine) instead of dropping them.
            const uri = (item as { uri?: unknown } | null)?.uri;
            yield {
              adapterId: BLUESKY_ADAPTER_ID,
              externalId: typeof uri === 'string' && uri ? uri : `malformed-${page}-${rank}`,
              fetchedAt,
              payload: { kind: 'native', post: item },
              context: { query: params.q, rank },
            } satisfies RawItem;
            continue;
          }
          const context = { ...postContext(post.data, params.q), rank };
          if (params.include !== 'links' && nativeVideo(post.data.embed)) {
            if (yielded >= req.limit) return;
            yielded += 1;
            yield {
              adapterId: BLUESKY_ADAPTER_ID,
              externalId: post.data.uri,
              fetchedAt,
              payload: { kind: 'native', post: item },
              context,
            } satisfies RawItem;
          }
          if (params.include === 'native') continue;
          const linked = linkedVideos(post.data);
          const seenIds = new Set(
            linked.map((l) => `${l.resolved.platform}:${l.resolved.platformVideoId}`),
          );
          const expanded: { url: string; resolved?: ResolvedVideoUrl; error?: string }[] = [];
          if (expandShortLinks) {
            for (const url of shortLinks(post.data)) {
              const result = await expand(url);
              if (!result.ok) {
                expanded.push({ url, error: `${result.reason}: ${result.message}` });
                continue;
              }
              const key = `${result.resolved.platform}:${result.resolved.platformVideoId}`;
              if (seenIds.has(key)) continue;
              seenIds.add(key);
              expanded.push({ url, resolved: result.resolved });
            }
          }
          for (const { url, resolved, error } of expanded) {
            if (yielded >= req.limit) return;
            yielded += 1;
            // Failed expansions are yielded too, so the run quarantines them visibly.
            yield {
              adapterId: BLUESKY_ADAPTER_ID,
              externalId: resolved
                ? `${post.data.uri}#${resolved.platform}:${resolved.platformVideoId}`
                : `${post.data.uri}#unresolved:${url}`,
              fetchedAt,
              payload: resolved
                ? { kind: 'link', post: item, url, resolvedUrl: resolved.canonicalUrl }
                : { kind: 'link', post: item, url, expansionError: error },
              context: {
                ...context,
                linkedUrl: url,
                ...(resolved ? { expandedTo: resolved.canonicalUrl } : {}),
              },
              observationKey: post.data.uri,
            } satisfies RawItem;
          }
          for (const { url, resolved } of linked) {
            if (yielded >= req.limit) return;
            yielded += 1;
            yield {
              adapterId: BLUESKY_ADAPTER_ID,
              externalId: `${post.data.uri}#${resolved.platform}:${resolved.platformVideoId}`,
              fetchedAt,
              payload: { kind: 'link', post: item, url },
              context: { ...context, linkedUrl: url },
              // One sighting per post that links the video.
              observationKey: post.data.uri,
            } satisfies RawItem;
          }
        }
        cursor = body.data.cursor;
        if (!cursor || body.data.posts.length === 0) return;
      }
    },

    async refreshMetrics(refs: readonly VideoRef[], ctx: AdapterContext) {
      const results: MetricRefreshResult[] = [];
      for (let i = 0; i < refs.length; i += GET_POSTS_MAX) {
        const uris = refs.slice(i, i + GET_POSTS_MAX).map((r) => r.platformVideoId);
        const body = GetPostsResponse.safeParse(
          await xrpc(
            'app.bsky.feed.getPosts',
            new URLSearchParams(uris.map((u) => ['uris', u])),
            ctx,
          ),
        );
        if (!body.success)
          throw new UpstreamError(
            SERVICE,
            'invalid_response',
            'getPosts response has no posts array',
          );
        const observedAt = ctx.now();
        const byUri = new Map<string, PostView>();
        for (const item of body.data.posts) {
          const post = PostView.safeParse(item);
          if (post.success) byUri.set(post.data.uri, post.data);
        }
        for (const uri of uris) {
          const post = byUri.get(uri);
          results.push(
            post
              ? {
                  platformVideoId: uri,
                  availability: 'available',
                  metrics: postMetrics(post),
                  observedAt,
                }
              : // getPosts silently omits deleted or hidden posts.
                { platformVideoId: uri, availability: 'unknown', metrics: null, observedAt },
          );
        }
      }
      return results;
    },

    normalize(raw: RawItem): NormalizedVideo {
      const payload = Payload.parse(raw.payload);
      const { post } = payload;

      if (payload.kind === 'link') {
        if (payload.expansionError) {
          throw new Error(`short link not resolved: ${payload.expansionError}`);
        }
        const resolved = resolveVideoUrl(payload.resolvedUrl ?? payload.url);
        if (!resolved.ok)
          throw new Error(`linked URL is not a supported video: ${resolved.message}`);
        const card = externalEmbed(post.embed);
        const cardResolved = card ? resolveVideoUrl(card.uri) : null;
        const cardIsThisVideo =
          cardResolved?.ok === true && cardResolved.platformVideoId === resolved.platformVideoId;
        // A reference: identity + canonical URL only. The link card's title is used
        // only to fill an empty title; it never overrides the canonical platform.
        return {
          platform: resolved.platform,
          platformVideoId: resolved.platformVideoId,
          canonicalUrl: resolved.canonicalUrl,
          creator: null,
          title: cardIsThisVideo && card?.title ? card.title : null,
          caption: null,
          publishedAt: null,
          durationMs: null,
          thumbnailUrl: null,
          language: null,
          contentOrigin: 'discovered_external',
          availability: 'unknown',
          metrics: null,
          observedAt: raw.fetchedAt,
        };
      }

      const video = nativeVideo(post.embed);
      if (!video) throw new Error('post has no native video embed');
      const thumbnail =
        video.thumbnail && /^https?:\/\//.test(video.thumbnail) ? video.thumbnail : null;
      const lang = post.record.langs?.[0];
      return {
        platform: 'bluesky',
        platformVideoId: post.uri,
        canonicalUrl: postWebUrl(post.uri),
        creator: {
          platform: 'bluesky',
          platformCreatorId: post.author.did,
          handle: post.author.handle,
          displayName: post.author.displayName || null,
          profileUrl: `https://bsky.app/profile/${post.author.did}`,
          followerCount: null,
        },
        title: null,
        caption: post.record.text || null,
        publishedAt: date(post.record.createdAt),
        durationMs: null, // not exposed by the video embed view
        thumbnailUrl: thumbnail,
        language: lang && lang.length >= 2 && lang.length <= 16 ? lang : null,
        contentOrigin: 'discovered_external',
        availability: 'available',
        metrics: postMetrics(post),
        observedAt: raw.fetchedAt,
      };
    },
  };
}
