/**
 * Provider-neutral TikTok adapter: discovery, URL lookup (reference enrichment) and
 * metric refresh through a TikTokPublicProvider. Nothing here knows which source is
 * behind it.
 *
 * NOT wired into the registry: no free/no-cost TikTok source exists yet (paid data
 * providers are out of scope for this project). It is kept, with its tests, so a
 * future free source only has to implement TikTokPublicProvider.
 */
import { z } from 'zod';
import {
  AdapterManifestSchema,
  consumeQuota,
  type AdapterManifest,
  parseParams,
  type AdapterContext,
  type DiscoveryRequest,
  type MetricRefreshResult,
  type NormalizedVideo,
  type RawItem,
  type SourceAdapter,
  type VideoRef,
} from '@vd/adapter-contract';
import { buildReadings, metricUnavailable, metricValue, type MetricReadings } from '@vd/core';
import { resolveVideoUrl } from '@vd/url-identity';
import type {
  TikTokProviderCallContext,
  TikTokProviderError,
  TikTokPublicPost,
  TikTokPublicProvider,
} from './provider.ts';

export const TIKTOK_ADAPTER_ID = 'tiktok';

/** The manifest for a given provider (its display name and access method). */
export function tiktokManifest(provider: TikTokPublicProvider): AdapterManifest {
  return AdapterManifestSchema.parse({
    id: TIKTOK_ADAPTER_ID,
    platform: 'tiktok',
    displayName: `TikTok via ${provider.displayName}`,
    version: '1.0.0',
    accessMethod: provider.accessMethod,
    capabilities: ['discovery.search', 'discovery.url', 'metrics.refresh', 'normalize'],
    metricsProvided: ['views', 'likes', 'comments', 'shares'],
    quotaBuckets: [
      {
        name: 'requests',
        unit: 'requests',
        defaultDailyBudget: null,
        notes: 'HTTP requests the provider makes',
      },
    ],
    requiredEnv: [],
    docsPath: 'docs/sources/tiktok.md',
  });
}

/** SourceQuery kind "search": one keyword or hashtag per stored query. */
export const SearchParamsSchema = z.object({
  q: z.string().trim().min(1, 'a search keyword is required').max(100),
  /** Posts to request. */
  maxResults: z.coerce.number().int().min(1).max(100).default(20),
  /** Optional ISO country hint for the provider. */
  country: z
    .string()
    .transform((s) => s.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{2}$/, 'must be an ISO 3166-1 alpha-2 code'))
    .optional(),
});
export type SearchParams = z.infer<typeof SearchParamsSchema>;

/** The neutral payload stored as the raw item (never provider-specific fields). */
type Payload =
  | { kind: 'post'; provider: string; post: TikTokPublicPost }
  | { kind: 'error'; provider: string; error: TikTokProviderError };

function readings(post: TikTokPublicPost): MetricReadings {
  // Not reported ⇒ unavailable; an explicit 0 from the provider stays 0.
  const r = (v: number | null) => (v === null ? metricUnavailable('unknown') : metricValue(v));
  return buildReadings({
    views: r(post.views),
    likes: r(post.likes),
    comments: r(post.comments),
    shares: r(post.shares),
  });
}

/** Canonical TikTok identity for a post, via the shared URL-identity rules. */
export function canonicalOf(post: TikTokPublicPost): {
  platformVideoId: string;
  canonicalUrl: string;
} {
  const candidates = [
    post.url,
    post.creatorUsername
      ? `https://www.tiktok.com/@${post.creatorUsername}/video/${post.videoId}`
      : null,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = resolveVideoUrl(candidate);
    if (resolved.ok && resolved.platform === 'tiktok' && resolved.platformVideoId === post.videoId)
      return { platformVideoId: resolved.platformVideoId, canonicalUrl: resolved.canonicalUrl };
  }
  throw new Error(`no canonical TikTok URL for video ${post.videoId} (url/username missing)`);
}

export interface TikTokAdapterOptions {
  provider: TikTokPublicProvider;
}

export function createTikTokAdapter(options: TikTokAdapterOptions): SourceAdapter {
  const { provider } = options;
  const manifest = tiktokManifest(provider);

  const callContext = (ctx: AdapterContext): TikTokProviderCallContext => ({
    signal: ctx.signal,
    meter: {
      request: () => {
        consumeQuota(ctx.quota, 'requests');
      },
    },
  });

  async function lookupBatch(
    urls: readonly string[],
    ctx: AdapterContext,
  ): Promise<Map<string, TikTokPublicPost>> {
    const byId = new Map<string, TikTokPublicPost>();
    for (let i = 0; i < urls.length; i += provider.maxLookupBatch) {
      const batch = urls.slice(i, i + provider.maxLookupBatch);
      const result = await provider.lookupPosts(batch, callContext(ctx));
      for (const post of result.posts) byId.set(post.videoId, post);
    }
    return byId;
  }

  const lookupUrls = async (urls: readonly string[], ctx: AdapterContext) => {
    const resolved = urls.map((u) => {
      const r = resolveVideoUrl(u);
      return r.ok && r.platform === 'tiktok' ? r : null;
    });
    const wanted = [...new Set(resolved.flatMap((r) => (r ? [r.canonicalUrl] : [])))];
    const posts = wanted.length
      ? await lookupBatch(wanted, ctx)
      : new Map<string, TikTokPublicPost>();
    const fetchedAt = ctx.now();
    return resolved.map((r): RawItem | null => {
      const post = r ? posts.get(r.platformVideoId) : undefined;
      return post
        ? {
            adapterId: TIKTOK_ADAPTER_ID,
            externalId: post.videoId,
            fetchedAt,
            payload: { kind: 'post', provider: provider.id, post } satisfies Payload,
            context: { lookup: true, provider: provider.id },
          }
        : null;
    });
  };

  return {
    manifest,

    async *discoverSearch(req: DiscoveryRequest, ctx: AdapterContext) {
      const params = parseParams(TIKTOK_ADAPTER_ID, SearchParamsSchema, req.params);
      const result = await provider.searchPosts(
        {
          keyword: params.q,
          limit: Math.min(params.maxResults, req.limit),
          country: params.country ?? null,
        },
        callContext(ctx),
      );
      const fetchedAt = ctx.now();
      let rank = 0;
      for (const post of result.posts) {
        rank += 1;
        yield {
          adapterId: TIKTOK_ADAPTER_ID,
          externalId: post.videoId,
          fetchedAt,
          payload: { kind: 'post', provider: provider.id, post } satisfies Payload,
          context: {
            query: params.q,
            rank,
            provider: provider.id,
            ...(params.country ? { country: params.country } : {}),
            ...(post.hashtags.length ? { hashtags: post.hashtags } : {}),
          },
          // One sighting per stored query: two queries finding a video = two sightings.
          observationKey: `search:${params.q}`,
        } satisfies RawItem;
      }
      // Provider-reported failures are surfaced (quarantined), never silently dropped.
      let n = 0;
      for (const error of result.errors) {
        n += 1;
        yield {
          adapterId: TIKTOK_ADAPTER_ID,
          externalId: `provider-error-${n}`,
          fetchedAt,
          payload: { kind: 'error', provider: provider.id, error } satisfies Payload,
          context: { query: params.q, provider: provider.id },
        } satisfies RawItem;
      }
    },

    async lookupUrl(url: string, ctx: AdapterContext) {
      const [item] = await lookupUrls([url], ctx);
      return item ?? null;
    },

    lookupUrls,

    async refreshMetrics(refs: readonly VideoRef[], ctx: AdapterContext) {
      const posts = await lookupBatch(
        refs.map((r) => r.canonicalUrl),
        ctx,
      );
      const observedAt = ctx.now();
      return refs.map((ref): MetricRefreshResult => {
        const post = posts.get(ref.platformVideoId);
        return post
          ? {
              platformVideoId: ref.platformVideoId,
              availability: 'available',
              metrics: readings(post),
              observedAt,
            }
          : // Not returned (removed, private, or a provider error): never guessed.
            {
              platformVideoId: ref.platformVideoId,
              availability: 'unknown',
              metrics: null,
              observedAt,
            };
      });
    },

    normalize(raw: RawItem): NormalizedVideo {
      const payload = raw.payload as Payload;
      if (payload.kind === 'error') {
        throw new Error(
          `${payload.provider} could not deliver this item (${payload.error.code ?? 'error'}): ${payload.error.message}`,
        );
      }
      const { post } = payload;
      if (post.postType === 'image') throw new Error('TikTok photo/carousel posts are not videos');
      const { platformVideoId, canonicalUrl } = canonicalOf(post);
      const publishedAt = post.publishedAt ? new Date(post.publishedAt) : null;
      return {
        platform: 'tiktok',
        platformVideoId,
        canonicalUrl,
        creator: post.creatorUsername
          ? {
              platform: 'tiktok',
              platformCreatorId: post.creatorId,
              handle: post.creatorUsername,
              displayName: post.creatorDisplayName,
              profileUrl: `https://www.tiktok.com/@${post.creatorUsername}`,
              followerCount: post.creatorFollowers,
            }
          : null,
        title: null,
        caption: post.caption,
        publishedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : null,
        durationMs: post.durationSeconds === null ? null : Math.round(post.durationSeconds * 1000),
        thumbnailUrl: post.coverUrl,
        language: null,
        contentOrigin: 'discovered_external',
        availability: 'available',
        metrics: readings(post),
        observedAt: raw.fetchedAt,
      };
    },
  };
}
