import { z } from 'zod';
import {
  AdapterManifestSchema,
  UpstreamError,
  consumeQuota,
  requestJson,
  type AdapterContext,
  type FetchLike,
  type NormalizedVideo,
  type RawItem,
  type SourceAdapter,
} from '@vd/adapter-contract';
import { resolveVideoUrl } from '@vd/url-identity';
import { expandTikTokShortLink, type ShortLinkFailure } from '@vd/url-resolution';

export const MANUAL_URL_ADAPTER_ID = 'manual-url';
/** TikTok's documented oEmbed endpoint (developers.tiktok.com/doc/embed-videos, updated 2026-08-04). */
export const TIKTOK_OEMBED_URL = 'https://www.tiktok.com/oembed';

/**
 * A human pastes a URL. Every submission is a *reference* to a video on its
 * canonical platform (YouTube, TikTok, Twitch); this adapter never claims to be
 * authoritative about it and never reports metrics. When a canonical adapter
 * with discovery.url is configured, the pipeline prefers it; this adapter is the
 * credential-free fallback.
 */
export const manifest = AdapterManifestSchema.parse({
  id: MANUAL_URL_ADAPTER_ID,
  platform: 'manual',
  displayName: 'Manual URL submission',
  version: '1.0.0',
  accessMethod: 'manual',
  capabilities: ['discovery.url', 'normalize'],
  metricsProvided: [],
  referencePlatforms: ['youtube', 'tiktok', 'twitch'],
  quotaBuckets: [
    {
      name: 'tiktok-shortlink',
      unit: 'expansions',
      defaultDailyBudget: null,
      notes:
        'HEAD requests to allowlisted TikTok hosts to expand /t/, vm., vt. share links (≤3 hops each)',
    },
    {
      name: 'tiktok-oembed',
      unit: 'requests',
      defaultDailyBudget: null,
      notes: 'no published limit; one request per submitted TikTok URL',
    },
  ],
  requiredEnv: [],
  docsPath: 'docs/sources/manual-url.md',
});

/** Fields TikTok documents in its oEmbed example. Nothing else is assumed. */
export const TikTokOEmbedSchema = z.object({
  version: z.string().optional(),
  type: z.string().optional(),
  title: z.string().optional(),
  author_url: z.string().optional(),
  author_name: z.string().optional(),
  thumbnail_url: z.string().optional(),
  thumbnail_width: z.number().optional(),
  thumbnail_height: z.number().optional(),
  provider_name: z.string().optional(),
});
export type TikTokOEmbed = z.infer<typeof TikTokOEmbedSchema>;

const Payload = z.object({
  submittedUrl: z.string(),
  /** Canonical URL after short-link expansion, when the submission was a short link. */
  resolvedUrl: z.string().nullable().optional(),
  oembed: TikTokOEmbedSchema.nullable(),
});

function failureKind(reason: ShortLinkFailure) {
  switch (reason) {
    case 'timeout':
      return 'timeout' as const;
    case 'network':
      return 'network' as const;
    case 'http_error':
    case 'not_a_video':
      return 'not_found' as const;
    default:
      return 'invalid_response' as const;
  }
}

export interface ManualUrlAdapterOptions {
  fetch?: FetchLike;
  tiktokOEmbedUrl?: string;
}

function httpsUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** "https://www.tiktok.com/@some.user" → "some.user" */
function tiktokHandle(authorUrl: string | undefined): string | null {
  const match = authorUrl ? /tiktok\.com\/@([A-Za-z0-9._]+)/.exec(authorUrl) : null;
  return match?.[1] ?? null;
}

export function createManualUrlAdapter(options: ManualUrlAdapterOptions = {}): SourceAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const oembedUrl = options.tiktokOEmbedUrl ?? TIKTOK_OEMBED_URL;

  async function tiktokOEmbed(canonicalUrl: string, ctx: AdapterContext): Promise<TikTokOEmbed> {
    consumeQuota(ctx.quota, 'tiktok-oembed');
    const url = new URL(oembedUrl);
    url.searchParams.set('url', canonicalUrl);
    const body = await requestJson(url, {
      service: 'tiktok-oembed',
      fetch: fetchImpl,
      signal: ctx.signal,
      classify: (status) =>
        status === 400 || status === 404
          ? {
              kind: 'not_found',
              detail:
                'TikTok did not return an embed; the video may be private, removed, or the URL wrong',
            }
          : undefined,
    });
    const parsed = TikTokOEmbedSchema.safeParse(body);
    if (!parsed.success) {
      throw new UpstreamError('tiktok-oembed', 'invalid_response', 'unexpected oEmbed response');
    }
    return parsed.data;
  }

  return {
    manifest,

    async lookupUrl(url: string, ctx: AdapterContext): Promise<RawItem | null> {
      let resolved = resolveVideoUrl(url);
      let expandedFrom: string | null = null;
      if (!resolved.ok && resolved.reason === 'short_link' && resolved.platform === 'tiktok') {
        consumeQuota(ctx.quota, 'tiktok-shortlink');
        const expanded = await expandTikTokShortLink(url, { fetch: fetchImpl, signal: ctx.signal });
        if (!expanded.ok) {
          throw new UpstreamError(
            'tiktok-shortlink',
            failureKind(expanded.reason),
            `short link not resolved (${expanded.reason}): ${expanded.message}`,
          );
        }
        resolved = expanded.resolved;
        expandedFrom = url;
      }
      if (!resolved.ok) return null;
      // Only TikTok is enriched here (its oEmbed needs no credentials). YouTube and
      // Twitch submissions are recorded by identity; their own adapters add metadata.
      const oembed =
        resolved.platform === 'tiktok' ? await tiktokOEmbed(resolved.canonicalUrl, ctx) : null;
      return {
        adapterId: MANUAL_URL_ADAPTER_ID,
        externalId: `${resolved.platform}:${resolved.platformVideoId}`,
        fetchedAt: ctx.now(),
        payload: {
          submittedUrl: url,
          resolvedUrl: expandedFrom ? resolved.canonicalUrl : null,
          oembed,
        },
        context: {
          submittedUrl: url,
          urlKind: resolved.kind,
          ...(expandedFrom ? { expandedFrom, expandedTo: resolved.canonicalUrl } : {}),
        },
      };
    },

    normalize(raw: RawItem): NormalizedVideo {
      const { submittedUrl, resolvedUrl, oembed } = Payload.parse(raw.payload);
      const resolved = resolveVideoUrl(resolvedUrl ?? submittedUrl);
      if (!resolved.ok) throw new Error(`unsupported URL: ${resolved.message}`);
      const handle = tiktokHandle(oembed?.author_url);
      return {
        platform: resolved.platform,
        platformVideoId: resolved.platformVideoId,
        canonicalUrl: resolved.canonicalUrl,
        creator:
          oembed && (oembed.author_name || handle)
            ? {
                platform: resolved.platform,
                platformCreatorId: null, // oEmbed exposes no stable account id
                handle,
                displayName: oembed.author_name || null,
                profileUrl: httpsUrl(oembed.author_url),
                followerCount: null,
              }
            : null,
        title: oembed?.title || null,
        caption: null,
        publishedAt: null,
        durationMs: null,
        thumbnailUrl: httpsUrl(oembed?.thumbnail_url),
        language: null,
        contentOrigin: 'discovered_external',
        // A successful oEmbed means TikTok serves the embed right now; otherwise unverified.
        availability: oembed ? 'available' : 'unknown',
        metrics: null,
        observedAt: raw.fetchedAt,
      };
    },
  };
}
