import { z } from 'zod';
import {
  AdapterManifestSchema,
  UpstreamError,
  consumeQuota,
  parseParams,
  requestJson,
  type AdapterContext,
  type DiscoveryRequest,
  type FetchLike,
  type MetricRefreshResult,
  type NormalizedVideo,
  type RawItem,
  type SourceAdapter,
  type VideoRef,
} from '@vd/adapter-contract';
import { buildReadings, metricValue } from '@vd/core';
import { resolveVideoUrl, twitchClipCanonicalUrl } from '@vd/url-identity';

export const TWITCH_ADAPTER_ID = 'twitch';
const SERVICE = 'twitch';
const HELIX_BASE = 'https://api.twitch.tv/helix';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
/** Get Clips accepts at most 100 ids per request (verified 2026-09-28). */
export const CLIPS_BY_ID_MAX = 100;

export const manifest = AdapterManifestSchema.parse({
  id: TWITCH_ADAPTER_ID,
  platform: 'twitch',
  displayName: 'Twitch Helix API (clips)',
  version: '1.0.0',
  accessMethod: 'official_api',
  capabilities: [
    'discovery.trending',
    'discovery.feed',
    'discovery.url',
    'metrics.refresh',
    'normalize',
  ],
  metricsProvided: ['views'],
  quotaBuckets: [
    {
      name: 'default',
      unit: 'points',
      defaultDailyBudget: null,
      notes: 'Twitch meters a per-minute token bucket (Ratelimit-* headers), not a daily quota',
    },
  ],
  requiredEnv: ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET'],
  docsPath: 'docs/sources/twitch.md',
});

const numericId = z.string().regex(/^\d+$/, 'must be a numeric Twitch id');
const rfc3339 = z.iso.datetime({ offset: true });
const boolParam = z.preprocess(
  (v) => (v === 'true' ? true : v === 'false' ? false : v),
  z.boolean(),
);

/**
 * Params for Get Clips. kind "trending" needs gameId; kind "channel_feed" needs
 * broadcasterId. The window is either startedAt+endedAt or lookbackHours (relative
 * to the run's clock).
 */
export const ClipParamsSchema = z
  .object({
    gameId: numericId.optional(),
    broadcasterId: numericId.optional(),
    startedAt: rfc3339.optional(),
    endedAt: rfc3339.optional(),
    lookbackHours: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 365)
      .optional(),
    first: z.coerce.number().int().min(1).max(100).default(20),
    pages: z.coerce.number().int().min(1).max(10).default(1),
    isFeatured: boolParam.optional(),
  })
  .superRefine((p, ctx) => {
    if ((p.startedAt === undefined) !== (p.endedAt === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['endedAt'],
        message: 'startedAt and endedAt go together',
      });
    }
    if (p.lookbackHours !== undefined && p.startedAt !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['lookbackHours'],
        message: 'use either lookbackHours or startedAt/endedAt',
      });
    }
  });
export type ClipParams = z.infer<typeof ClipParamsSchema>;

/** One clip, per the Get Clips reference. Fields the docs do not guarantee are optional. */
export const ClipSchema = z.object({
  id: z.string().min(1),
  url: z.string().optional(),
  embed_url: z.string().optional(),
  broadcaster_id: z.string().min(1),
  broadcaster_name: z.string().optional(),
  creator_id: z.string().optional(),
  creator_name: z.string().optional(),
  video_id: z.string().optional(),
  game_id: z.string().optional(),
  language: z.string().optional(),
  title: z.string().optional(),
  view_count: z.number().int().nonnegative(),
  created_at: rfc3339,
  thumbnail_url: z.string().optional(),
  duration: z.number().nonnegative().optional(),
  vod_offset: z.number().nullable().optional(),
  is_featured: z.boolean().optional(),
});
export type Clip = z.infer<typeof ClipSchema>;

const ClipsResponse = z.object({
  data: z.array(z.unknown()),
  pagination: z.object({ cursor: z.string().optional() }).optional(),
});
const TokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  token_type: z.string().optional(),
});

export interface TwitchAdapterOptions {
  clientId: string;
  clientSecret: string;
  fetch?: FetchLike;
  helixBase?: string;
  tokenUrl?: string;
}

function httpUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Twitch's Ratelimit-Reset is a Unix timestamp (seconds). */
function secondsUntilReset(headers: Headers): number | null {
  const reset = Number(headers.get('ratelimit-reset'));
  if (!Number.isFinite(reset) || reset <= 0) return null;
  return Math.max(0, Math.ceil(reset - Date.now() / 1000));
}

export function createTwitchAdapter(options: TwitchAdapterOptions): SourceAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const helixBase = options.helixBase ?? HELIX_BASE;
  const tokenUrl = options.tokenUrl ?? TOKEN_URL;
  let token: { value: string; expiresAt: number } | null = null;

  async function getToken(ctx: AdapterContext, force = false): Promise<string> {
    const now = ctx.now().getTime();
    if (!force && token && token.expiresAt - 60_000 > now) return token.value;
    // Client-credentials grant; the secret travels in the POST body, never the URL.
    const body = await requestJson(tokenUrl, {
      service: SERVICE,
      fetch: fetchImpl,
      signal: ctx.signal,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          grant_type: 'client_credentials',
        }).toString(),
      },
      classify: (status) =>
        status === 400 || status === 401 || status === 403
          ? {
              kind: 'unauthorized',
              detail: 'app access token refused; check TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET',
            }
          : undefined,
    });
    const parsed = TokenResponse.safeParse(body);
    if (!parsed.success)
      throw new UpstreamError(SERVICE, 'invalid_response', 'unexpected token response');
    token = { value: parsed.data.access_token, expiresAt: now + parsed.data.expires_in * 1000 };
    return token.value;
  }

  async function helix(path: string, query: URLSearchParams, ctx: AdapterContext) {
    const url = new URL(`${helixBase}/${path}`);
    url.search = query.toString();
    const call = async (accessToken: string) => {
      consumeQuota(ctx.quota, 'default');
      return requestJson(url, {
        service: SERVICE,
        fetch: fetchImpl,
        signal: ctx.signal,
        init: {
          headers: { 'Client-Id': options.clientId, Authorization: `Bearer ${accessToken}` },
        },
        retryAfter: secondsUntilReset,
      });
    };
    let body: unknown;
    try {
      body = await call(await getToken(ctx));
    } catch (err) {
      // App access tokens expire without a refresh token: fetch a new one once.
      if (!(err instanceof UpstreamError) || err.kind !== 'unauthorized') throw err;
      body = await call(await getToken(ctx, true));
    }
    const parsed = ClipsResponse.safeParse(body);
    if (!parsed.success)
      throw new UpstreamError(SERVICE, 'invalid_response', 'Get Clips response has no data array');
    return parsed.data;
  }

  async function* discoverClips(
    filter: { gameId: string } | { broadcasterId: string },
    params: ClipParams,
    req: DiscoveryRequest,
    ctx: AdapterContext,
  ): AsyncGenerator<RawItem> {
    const base = new URLSearchParams();
    if ('gameId' in filter) base.set('game_id', filter.gameId);
    else base.set('broadcaster_id', filter.broadcasterId);
    let startedAt = params.startedAt;
    let endedAt = params.endedAt;
    if (params.lookbackHours !== undefined) {
      const now = ctx.now();
      endedAt = now.toISOString();
      startedAt = new Date(now.getTime() - params.lookbackHours * 3_600_000).toISOString();
    }
    if (startedAt && endedAt) {
      base.set('started_at', startedAt);
      base.set('ended_at', endedAt);
    }
    if (params.isFeatured !== undefined) base.set('is_featured', String(params.isFeatured));
    base.set('first', String(Math.min(params.first, req.limit)));

    let cursor: string | undefined;
    let rank = 0;
    for (let page = 1; page <= params.pages; page++) {
      if (ctx.signal.aborted || rank >= req.limit) return;
      const query = new URLSearchParams(base);
      if (cursor) query.set('after', cursor);
      const body = await helix('clips', query, ctx);
      const fetchedAt = ctx.now();
      for (const clip of body.data) {
        if (rank >= req.limit) return;
        rank += 1;
        const id = (clip as { id?: unknown }).id;
        yield {
          adapterId: TWITCH_ADAPTER_ID,
          externalId: typeof id === 'string' && id ? id : `unknown-${rank}`,
          fetchedAt,
          payload: clip,
          context: {
            ...filter,
            startedAt: startedAt ?? null,
            endedAt: endedAt ?? null,
            rank,
          },
        };
      }
      cursor = body.pagination?.cursor;
      if (!cursor || body.data.length === 0) return;
    }
  }

  return {
    manifest,

    async *discoverTrending(req, ctx) {
      const params = parseParams(TWITCH_ADAPTER_ID, ClipParamsSchema, req.params);
      if (!params.gameId) {
        throw new Error('twitch "trending" discovery needs params.gameId (top clips for a game)');
      }
      yield* discoverClips({ gameId: params.gameId }, params, req, ctx);
    },

    async *discoverFeed(req, ctx) {
      const params = parseParams(TWITCH_ADAPTER_ID, ClipParamsSchema, req.params);
      if (!params.broadcasterId) {
        throw new Error('twitch "channel_feed" discovery needs params.broadcasterId');
      }
      yield* discoverClips({ broadcasterId: params.broadcasterId }, params, req, ctx);
    },

    async lookupUrl(url: string, ctx: AdapterContext) {
      const resolved = resolveVideoUrl(url);
      if (!resolved.ok || resolved.platform !== 'twitch') return null;
      const body = await helix('clips', new URLSearchParams({ id: resolved.platformVideoId }), ctx);
      const [clip] = body.data;
      if (clip === undefined) return null;
      return {
        adapterId: TWITCH_ADAPTER_ID,
        externalId: resolved.platformVideoId,
        fetchedAt: ctx.now(),
        payload: clip,
        context: { submittedUrl: url },
      };
    },

    async refreshMetrics(refs: readonly VideoRef[], ctx: AdapterContext) {
      const results: MetricRefreshResult[] = [];
      for (let i = 0; i < refs.length; i += CLIPS_BY_ID_MAX) {
        const ids = refs.slice(i, i + CLIPS_BY_ID_MAX).map((r) => r.platformVideoId);
        const query = new URLSearchParams(ids.map((id) => ['id', id]));
        const body = await helix('clips', query, ctx);
        const observedAt = ctx.now();
        const views = new Map<string, number>();
        for (const item of body.data) {
          const clip = ClipSchema.safeParse(item);
          if (clip.success) views.set(clip.data.id, clip.data.view_count);
        }
        for (const id of ids) {
          const count = views.get(id);
          results.push(
            count === undefined
              ? // Not returned: deleted, or not visible to us — the API does not say which.
                { platformVideoId: id, availability: 'unknown', metrics: null, observedAt }
              : {
                  platformVideoId: id,
                  availability: 'available',
                  metrics: buildReadings({ views: metricValue(count) }),
                  observedAt,
                },
          );
        }
      }
      return results;
    },

    normalize(raw: RawItem): NormalizedVideo {
      const clip = ClipSchema.parse(raw.payload);
      const language = clip.language && clip.language !== 'other' ? clip.language : null;
      return {
        platform: 'twitch',
        platformVideoId: clip.id,
        canonicalUrl: twitchClipCanonicalUrl(clip.id),
        creator: {
          platform: 'twitch',
          platformCreatorId: clip.broadcaster_id,
          // broadcaster_name is a display name; the login (and so the profile URL) is not in the clip.
          handle: null,
          displayName: clip.broadcaster_name || null,
          profileUrl: null,
          followerCount: null,
        },
        title: clip.title || null,
        caption: null,
        publishedAt: new Date(clip.created_at),
        durationMs: clip.duration === undefined ? null : Math.round(clip.duration * 1000),
        thumbnailUrl: httpUrl(clip.thumbnail_url),
        language: language && language.length >= 2 && language.length <= 16 ? language : null,
        contentOrigin: 'discovered_external',
        availability: 'available',
        metrics: buildReadings({ views: metricValue(clip.view_count) }),
        observedAt: raw.fetchedAt,
      };
    },
  };
}
