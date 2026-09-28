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
import {
  BatchGetStatsResponse,
  ChannelListResponse,
  GoogleErrorBody,
  PlaylistItemsResponse,
  SearchListResponse,
  VideoListResponse,
  VideoResource,
} from './api.ts';
import { parseIsoDurationMs } from './duration.ts';

export const YOUTUBE_ADAPTER_ID = 'youtube';
const SERVICE = 'youtube';
const API_BASE = 'https://www.googleapis.com/youtube/v3';
const VIDEO_PARTS = 'snippet,contentDetails,statistics';
/**
 * APPLICATION batch size for videos:batchGetStats — not a documented YouTube
 * limit. The reference (2026-09-14) states no per-request id maximum; 50 mirrors
 * videos.list?id=. Configurable via YouTubeAdapterOptions.statsBatchSize.
 */
export const DEFAULT_STATS_BATCH_SIZE = 50;
/** videos.list?id= and channels.list?id= are fetched in chunks of this size. */
const ID_CHUNK = 50;
/** Largest first; the reference lists fhd/qhd/uhd too, but not every video has them. */
const THUMBNAIL_PREFERENCE = ['maxres', 'standard', 'high', 'medium', 'default'];

export const manifest = AdapterManifestSchema.parse({
  id: YOUTUBE_ADAPTER_ID,
  platform: 'youtube',
  displayName: 'YouTube Data API v3',
  version: '1.0.0',
  accessMethod: 'official_api',
  capabilities: [
    'discovery.trending',
    'discovery.search',
    'discovery.feed',
    'discovery.url',
    'metrics.refresh',
    'normalize',
  ],
  metricsProvided: ['views', 'likes', 'comments'],
  quotaBuckets: [
    {
      name: 'default',
      unit: 'units',
      defaultDailyBudget: 10_000,
      notes: 'videos.list costs 1 unit per call (verified 2026-09-28)',
    },
    {
      name: 'search.list',
      unit: 'calls',
      defaultDailyBudget: 100,
      notes:
        'Search Queries bucket: 1 unit per call, 100 calls/day by default (verified 2026-09-29)',
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

const rfc3339 = z.iso.datetime({ offset: true });

/**
 * Params for SourceQuery kind "search" (search.list type=video → videos.list).
 * One query string per SourceQuery, so each theme has its own cadence and cost.
 * `videoDuration: "short"` means < 4 minutes (API definition) — not "is a Short".
 */
export const SearchParamsSchema = z
  .object({
    q: z.string().trim().min(1, 'a search query is required'),
    regionCode: z
      .string()
      .transform((s) => s.toUpperCase())
      .pipe(z.string().regex(/^[A-Z]{2}$/, 'must be an ISO 3166-1 alpha-2 code'))
      .optional(),
    relevanceLanguage: z
      .string()
      .regex(/^[a-z]{2}(-Han[st])?$/, 'must be an ISO 639-1 code')
      .optional(),
    publishedAfter: rfc3339.optional(),
    /** Freshness window relative to the run clock; alternative to publishedAfter. */
    publishedWithinHours: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 365)
      .optional(),
    order: z.enum(['date', 'rating', 'relevance', 'title', 'viewCount']).default('relevance'),
    videoDuration: z.enum(['any', 'short', 'medium', 'long']).default('any'),
    videoCategoryId: z.string().regex(/^\d+$/).optional(),
    safeSearch: z.enum(['none', 'moderate', 'strict']).default('moderate'),
    /** Page size (API maxResults 0–50). */
    maxResults: z.coerce.number().int().min(1).max(50).default(25),
    /** Each page costs one search.list call (100/day by default). */
    pages: z.coerce.number().int().min(1).max(5).default(1),
  })
  .refine((p) => !(p.publishedAfter && p.publishedWithinHours), {
    message: 'use either publishedAfter or publishedWithinHours',
    path: ['publishedWithinHours'],
  });
export type SearchParams = z.infer<typeof SearchParamsSchema>;

/**
 * Params for SourceQuery kind "channel_feed": recent uploads of seed channels via
 * their uploads playlist (channels.list + playlistItems.list, 1 unit each) — no
 * search quota. Channel lists live in data, never in code.
 */
export const ChannelFeedParamsSchema = z
  .object({
    channelId: stringList(z.string().regex(/^UC[\w-]{22}$/, 'must be a UC… channel id')).optional(),
    handle: stringList(
      z.string().regex(/^@?[\w.-]{3,100}$/, 'must be a YouTube handle'),
    ).optional(),
    /** Skip channels.list when the uploads playlist id is already known. */
    uploadsPlaylistId: stringList(
      z.string().regex(/^UU[\w-]{22}$/, 'must be a UU… playlist id'),
    ).optional(),
    /** Newest uploads read per channel (1–50). */
    maxPerChannel: z.coerce.number().int().min(1).max(50).default(10),
    /** Skip uploads older than this (uses playlistItems contentDetails.videoPublishedAt). */
    publishedWithinHours: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 365)
      .optional(),
  })
  .refine(
    (p) =>
      (p.channelId?.length ?? 0) + (p.handle?.length ?? 0) + (p.uploadsPlaylistId?.length ?? 0) > 0,
    { message: 'set channelId, handle, or uploadsPlaylistId', path: ['channelId'] },
  );
export type ChannelFeedParams = z.infer<typeof ChannelFeedParamsSchema>;

export interface YouTubeAdapterOptions {
  apiKey: string;
  fetch?: FetchLike;
  apiBase?: string;
  /** Application batch size for videos:batchGetStats (default 50; not a YouTube limit). */
  statsBatchSize?: number;
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
  const statsBatchSize = options.statsBatchSize ?? DEFAULT_STATS_BATCH_SIZE;
  if (!Number.isInteger(statsBatchSize) || statsBatchSize < 1) {
    throw new RangeError('statsBatchSize must be a positive integer');
  }

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

  function parse<T extends z.ZodType>(schema: T, body: unknown, what: string): z.infer<T> {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new UpstreamError(SERVICE, 'invalid_response', `unexpected ${what} response`);
    }
    return parsed.data;
  }

  /** videos.list?id= in chunks of 50 (1 unit each); returns resources by id. */
  async function videosById(ids: readonly string[], ctx: AdapterContext) {
    const byId = new Map<string, unknown>();
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const chunk = ids.slice(i, i + ID_CHUNK);
      consumeQuota(ctx.quota, 'default');
      const body = parseList(await get('videos', { part: VIDEO_PARTS, id: chunk.join(',') }, ctx));
      for (const item of body.items) {
        const id = (item as { id?: unknown }).id;
        if (typeof id === 'string') byId.set(id, item);
      }
    }
    return byId;
  }

  /** Channel ids / handles → uploads playlist ids (channels.list, 1 unit per call). */
  async function uploadsPlaylists(params: ChannelFeedParams, ctx: AdapterContext) {
    const playlists = new Map<string, string>(); // playlistId → channel (id or handle)
    for (const id of params.uploadsPlaylistId ?? []) playlists.set(id, id);
    const ids = params.channelId ?? [];
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const chunk = ids.slice(i, i + ID_CHUNK);
      consumeQuota(ctx.quota, 'default');
      const body = parse(
        ChannelListResponse,
        await get('channels', { part: 'contentDetails', id: chunk.join(',') }, ctx),
        'channels.list',
      );
      for (const ch of body.items) {
        const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
        if (uploads) playlists.set(uploads, ch.id);
      }
      const found = new Set(body.items.map((c) => c.id));
      const missing = chunk.filter((id) => !found.has(id));
      if (missing.length) ctx.logger.warn({ missing }, 'youtube channels not found');
    }
    for (const handle of params.handle ?? []) {
      consumeQuota(ctx.quota, 'default');
      const forHandle = handle.startsWith('@') ? handle : `@${handle}`;
      const body = parse(
        ChannelListResponse,
        await get('channels', { part: 'contentDetails', forHandle }, ctx),
        'channels.list',
      );
      const channel = body.items[0];
      const uploads = channel?.contentDetails?.relatedPlaylists?.uploads;
      if (channel && uploads) playlists.set(uploads, channel.id);
      else ctx.logger.warn({ handle }, 'youtube handle not found');
    }
    return playlists;
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

    async *discoverSearch(req: DiscoveryRequest, ctx: AdapterContext) {
      const params = parseParams(YOUTUBE_ADAPTER_ID, SearchParamsSchema, req.params);
      const regionCode = params.regionCode ?? req.region?.toUpperCase();
      const publishedAfter =
        params.publishedAfter ??
        (params.publishedWithinHours
          ? new Date(ctx.now().getTime() - params.publishedWithinHours * 3_600_000).toISOString()
          : undefined);
      const context = {
        search: {
          q: params.q,
          order: params.order,
          regionCode: regionCode ?? null,
          relevanceLanguage: params.relevanceLanguage ?? null,
          videoDuration: params.videoDuration,
          publishedAfter: publishedAfter ?? null,
        },
      };
      let pageToken: string | undefined;
      let rank = 0;
      for (let page = 1; page <= params.pages; page++) {
        if (ctx.signal.aborted || rank >= req.limit) return;
        const query: Record<string, string> = {
          part: 'id',
          type: 'video',
          q: params.q,
          order: params.order,
          videoDuration: params.videoDuration,
          safeSearch: params.safeSearch,
          maxResults: String(Math.min(params.maxResults, req.limit - rank)),
        };
        if (regionCode) query['regionCode'] = regionCode;
        if (params.relevanceLanguage) query['relevanceLanguage'] = params.relevanceLanguage;
        if (publishedAfter) query['publishedAfter'] = publishedAfter;
        if (params.videoCategoryId) query['videoCategoryId'] = params.videoCategoryId;
        if (pageToken) query['pageToken'] = pageToken;
        consumeQuota(ctx.quota, 'search.list');
        const body = parse(SearchListResponse, await get('search', query, ctx), 'search.list');
        const ids = body.items.flatMap((i) => (i.id?.videoId ? [i.id.videoId] : []));
        const videos = await videosById(ids, ctx);
        const fetchedAt = ctx.now();
        for (const id of ids) {
          rank += 1;
          const item = videos.get(id);
          // A search hit that videos.list no longer returns (removed/private) is not a candidate.
          if (item === undefined) continue;
          yield {
            adapterId: YOUTUBE_ADAPTER_ID,
            externalId: id,
            fetchedAt,
            payload: item,
            context: { ...context, rank },
            observationKey: `search:${params.q}:${regionCode ?? '-'}`,
          } satisfies RawItem;
        }
        pageToken = body.nextPageToken;
        if (!pageToken) return;
      }
    },

    async *discoverFeed(req: DiscoveryRequest, ctx: AdapterContext) {
      // discovery.feed serves both feed kinds in the contract; YouTube has channels only.
      if (req.kind !== 'channel_feed') {
        throw new Error(`youtube feeds support kind "channel_feed" only, not "${req.kind}"`);
      }
      const params = parseParams(YOUTUBE_ADAPTER_ID, ChannelFeedParamsSchema, req.params);
      const cutoff = params.publishedWithinHours
        ? ctx.now().getTime() - params.publishedWithinHours * 3_600_000
        : null;
      const playlists = await uploadsPlaylists(params, ctx);
      const entries: { videoId: string; channel: string; playlistId: string; position: number }[] =
        [];
      for (const [playlistId, channel] of playlists) {
        consumeQuota(ctx.quota, 'default');
        const body = parse(
          PlaylistItemsResponse,
          await get(
            'playlistItems',
            { part: 'contentDetails', playlistId, maxResults: String(params.maxPerChannel) },
            ctx,
          ),
          'playlistItems.list',
        );
        let position = 0;
        for (const item of body.items) {
          const videoId = item.contentDetails?.videoId;
          if (!videoId) continue;
          position += 1;
          const published = item.contentDetails?.videoPublishedAt;
          // The freshness window is part of the query (like publishedAfter) and is applied
          // before spending videos.list quota on old uploads.
          if (cutoff !== null && published && Date.parse(published) < cutoff) continue;
          entries.push({ videoId, channel, playlistId, position });
        }
      }
      const limited = entries.slice(0, req.limit);
      const videos = await videosById([...new Set(limited.map((e) => e.videoId))], ctx);
      const fetchedAt = ctx.now();
      for (const entry of limited) {
        const item = videos.get(entry.videoId);
        if (item === undefined) continue;
        yield {
          adapterId: YOUTUBE_ADAPTER_ID,
          externalId: entry.videoId,
          fetchedAt,
          payload: item,
          context: {
            channelFeed: { channel: entry.channel, uploadsPlaylistId: entry.playlistId },
            rank: entry.position,
          },
          observationKey: `channel:${entry.channel}`,
        } satisfies RawItem;
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
      for (let i = 0; i < refs.length; i += statsBatchSize) {
        const ids = refs.slice(i, i + statsBatchSize).map((r) => r.platformVideoId);
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
