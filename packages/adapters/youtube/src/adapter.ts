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
import { buildReadings, metricUnavailable, metricValue, type MetricReading } from '@vd/core';
import { resolveVideoUrl, youtubeCanonicalUrl } from '@vd/url-identity';
import { BatchGetStatsResponse, GoogleErrorBody, VideoListResponse, VideoResource } from './api.ts';
import { parseIsoDurationMs } from './duration.ts';

export const YOUTUBE_ADAPTER_ID = 'youtube';
const SERVICE = 'youtube';
const API_BASE = 'https://www.googleapis.com/youtube/v3';
const VIDEO_PARTS = 'snippet,contentDetails,statistics';
/**
 * The batchGetStats reference (2026-09-14) states no per-request id limit. We use
 * 50, the documented limit for videos.list?id=, until a higher one is verified.
 */
export const BATCH_STATS_CHUNK = 50;
/** Largest first; the reference lists fhd/qhd/uhd too, but not every video has them. */
const THUMBNAIL_PREFERENCE = ['maxres', 'standard', 'high', 'medium', 'default'];

export const manifest = AdapterManifestSchema.parse({
  id: YOUTUBE_ADAPTER_ID,
  platform: 'youtube',
  displayName: 'YouTube Data API v3',
  version: '1.0.0',
  accessMethod: 'official_api',
  capabilities: ['discovery.trending', 'discovery.url', 'metrics.refresh', 'normalize'],
  metricsProvided: ['views', 'likes', 'comments'],
  quotaBuckets: [
    {
      name: 'default',
      unit: 'units',
      defaultDailyBudget: 10_000,
      notes: 'videos.list costs 1 unit per call (verified 2026-09-28)',
    },
    {
      name: 'videos.batchGetStats',
      unit: 'units',
      defaultDailyBudget: 10_000,
      notes: 'own granular bucket since 2026-06-03; 1 unit per call',
    },
  ],
  requiredEnv: ['YOUTUBE_API_KEY'],
  docsPath: 'docs/sources/youtube.md',
});

/**
 * Params for SourceQuery kind "trending" (videos.list chart=mostPopular).
 * Every region × category combination is queried; lists accept arrays or CSV.
 */
export const TrendingParamsSchema = z.object({
  regionCode: stringList(
    z
      .string()
      .transform((s) => s.toUpperCase())
      .pipe(z.string().regex(/^[A-Z]{2}$/, 'must be an ISO 3166-1 alpha-2 code')),
  ).optional(),
  videoCategoryId: stringList(
    z.string().regex(/^\d+$/, 'must be a numeric category id'),
  ).optional(),
  /** Page size, as the API's maxResults (1–50). */
  maxResults: z.coerce.number().int().min(1).max(50).default(50),
  /** Pages per region × category chart. */
  pages: z.coerce.number().int().min(1).max(10).default(1),
});
export type TrendingParams = z.infer<typeof TrendingParamsSchema>;

export interface YouTubeAdapterOptions {
  apiKey: string;
  fetch?: FetchLike;
  apiBase?: string;
}

function classifyGoogleError(status: number, body: unknown) {
  const parsed = GoogleErrorBody.safeParse(body);
  if (!parsed.success) return undefined;
  const reason = parsed.data.error.errors?.[0]?.reason;
  const detail = [reason, parsed.data.error.message].filter(Boolean).join(': ');
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
    return { kind: 'quota_exceeded' as const, detail };
  }
  if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') {
    return { kind: 'rate_limited' as const, detail };
  }
  if (
    reason === 'keyInvalid' ||
    reason === 'keyExpired' ||
    (status === 400 && reason === 'badRequest' && /API key/i.test(detail))
  ) {
    return { kind: 'unauthorized' as const, detail };
  }
  return { detail };
}

function count(value: number | undefined): MetricReading {
  // The docs do not say when a count is omitted (e.g. hidden likes, disabled
  // comments), so an absent count is "unknown" rather than a guessed reason.
  return value === undefined ? metricUnavailable('unknown') : metricValue(value);
}

function bestThumbnail(thumbnails: Record<string, { url: string }> | undefined): string | null {
  if (!thumbnails) return null;
  for (const key of THUMBNAIL_PREFERENCE) {
    const t = thumbnails[key];
    if (t) return t.url;
  }
  return null;
}

export function createYouTubeAdapter(options: YouTubeAdapterOptions): SourceAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const apiBase = options.apiBase ?? API_BASE;

  async function get(path: string, query: Record<string, string>, ctx: AdapterContext) {
    const url = new URL(`${apiBase}/${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return requestJson(url, {
      service: SERVICE,
      fetch: fetchImpl,
      signal: ctx.signal,
      // The key goes in a header so it can never leak through a logged URL.
      init: { headers: { 'X-goog-api-key': options.apiKey, Accept: 'application/json' } },
      classify: classifyGoogleError,
    });
  }

  function parseList(body: unknown) {
    const parsed = VideoListResponse.safeParse(body);
    if (!parsed.success) {
      throw new UpstreamError(
        SERVICE,
        'invalid_response',
        'videos.list response has no items array',
      );
    }
    return parsed.data;
  }

  return {
    manifest,

    async *discoverTrending(req: DiscoveryRequest, ctx: AdapterContext) {
      const params = parseParams(YOUTUBE_ADAPTER_ID, TrendingParamsSchema, req.params);
      const regions = params.regionCode ?? (req.region ? [req.region.toUpperCase()] : []);
      if (regions.length === 0) {
        throw new Error(
          'youtube trending needs at least one region: set params.regionCode (e.g. "US,GB") or the query region',
        );
      }
      const categories: (string | null)[] =
        params.videoCategoryId && params.videoCategoryId.length > 0
          ? params.videoCategoryId
          : [null];

      let yielded = 0;
      for (const regionCode of regions) {
        for (const categoryId of categories) {
          let pageToken: string | undefined;
          let rank = 0;
          for (let page = 1; page <= params.pages; page++) {
            if (ctx.signal.aborted || yielded >= req.limit) return;
            consumeQuota(ctx.quota, 'default');
            const query: Record<string, string> = {
              part: VIDEO_PARTS,
              chart: 'mostPopular',
              regionCode,
              maxResults: String(params.maxResults),
            };
            if (categoryId) query['videoCategoryId'] = categoryId;
            if (pageToken) query['pageToken'] = pageToken;
            const body = parseList(await get('videos', query, ctx));
            const fetchedAt = ctx.now();
            for (const item of body.items) {
              if (yielded >= req.limit) return;
              rank += 1;
              const id = VideoResource.shape.id.safeParse((item as { id?: unknown }).id);
              yield {
                adapterId: YOUTUBE_ADAPTER_ID,
                externalId: id.success ? id.data : `unknown-${regionCode}-${rank}`,
                fetchedAt,
                payload: item,
                context: {
                  chart: 'mostPopular',
                  regionCode,
                  videoCategoryId: categoryId,
                  rank,
                },
                observationKey: `mostPopular:${regionCode}:${categoryId ?? 'all'}`,
              } satisfies RawItem;
              yielded += 1;
            }
            pageToken = body.nextPageToken;
            if (!pageToken) break;
          }
        }
      }
    },

    async lookupUrl(url: string, ctx: AdapterContext) {
      const resolved = resolveVideoUrl(url);
      if (!resolved.ok || resolved.platform !== 'youtube') return null;
      consumeQuota(ctx.quota, 'default');
      const body = parseList(
        await get('videos', { part: VIDEO_PARTS, id: resolved.platformVideoId }, ctx),
      );
      const [item] = body.items;
      if (item === undefined) return null; // removed, private, or never existed
      return {
        adapterId: YOUTUBE_ADAPTER_ID,
        externalId: resolved.platformVideoId,
        fetchedAt: ctx.now(),
        payload: item,
        context: { submittedUrl: url, urlKind: resolved.kind },
      } satisfies RawItem;
    },

    async refreshMetrics(refs: readonly VideoRef[], ctx: AdapterContext) {
      const results: MetricRefreshResult[] = [];
      for (let i = 0; i < refs.length; i += BATCH_STATS_CHUNK) {
        const ids = refs.slice(i, i + BATCH_STATS_CHUNK).map((r) => r.platformVideoId);
        consumeQuota(ctx.quota, 'videos.batchGetStats');
        const body = BatchGetStatsResponse.safeParse(
          await get('videos:batchGetStats', { part: 'statistics', id: ids.join(',') }, ctx),
        );
        if (!body.success) {
          throw new UpstreamError(SERVICE, 'invalid_response', 'unexpected batchGetStats response');
        }
        const observedAt = ctx.now();
        const byId = new Map(body.data.items.map((item) => [item.id, item]));
        for (const id of ids) {
          const item = byId.get(id);
          const stats = item?.statistics;
          results.push(
            item && stats
              ? {
                  platformVideoId: id,
                  availability: 'available',
                  metrics: buildReadings({
                    views: count(stats.viewCount),
                    likes: count(stats.likeCount),
                    comments: count(stats.commentCount),
                  }),
                  observedAt,
                }
              : // In summary.failedVideoIds or simply absent: the API does not say why
                // (deleted, private, or transient), so availability stays "unknown".
                { platformVideoId: id, availability: 'unknown', metrics: null, observedAt },
          );
        }
      }
      return results;
    },

    normalize(raw: RawItem): NormalizedVideo {
      const video = VideoResource.parse(raw.payload);
      const { snippet } = video;
      const live =
        snippet.liveBroadcastContent === 'live' || snippet.liveBroadcastContent === 'upcoming';
      const durationMs = live ? null : parseIsoDurationMs(video.contentDetails?.duration);
      const language = snippet.defaultAudioLanguage ?? snippet.defaultLanguage ?? null;
      return {
        platform: 'youtube',
        platformVideoId: video.id,
        canonicalUrl: youtubeCanonicalUrl(video.id),
        creator: {
          platform: 'youtube',
          platformCreatorId: snippet.channelId,
          handle: null, // snippet has no @handle
          displayName: snippet.channelTitle || null,
          profileUrl: `https://www.youtube.com/channel/${snippet.channelId}`,
          followerCount: null,
        },
        title: snippet.title,
        caption: snippet.description || null,
        publishedAt: snippet.publishedAt ? new Date(snippet.publishedAt) : null,
        durationMs,
        thumbnailUrl: bestThumbnail(snippet.thumbnails),
        language: language && language.length >= 2 && language.length <= 16 ? language : null,
        contentOrigin: 'discovered_external',
        availability: 'available',
        metrics: video.statistics
          ? buildReadings({
              views: count(video.statistics.viewCount),
              likes: count(video.statistics.likeCount),
              comments: count(video.statistics.commentCount),
            })
          : null,
        observedAt: raw.fetchedAt,
      };
    },
  };
}
