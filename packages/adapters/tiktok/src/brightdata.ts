/**
 * Bright Data Web Scraper API as a TikTokPublicProvider (dataset "TikTok - Posts").
 *
 * Documented flow (docs.brightdata.com, Scraper API async requests; dataset schema
 * from docs.brightdata.com/scrapers-full.json, read 2026-10-03):
 *   POST /datasets/v3/trigger?dataset_id=…&include_errors=true[&type=discover_new&discover_by=keyword]
 *        body {"input": [...]}                      → {"snapshot_id"}
 *   GET  /datasets/v3/progress/{snapshot_id}         → {"status": starting|running|ready|failed|canceled}
 *   GET  /datasets/v3/snapshot/{snapshot_id}?format=json → [records]
 * Auth: "Authorization: Bearer <token>" (the token is only ever placed in that header).
 * Billing is per delivered record.
 *
 * Bright Data field names stop here: records are mapped to TikTokPublicPost using an
 * allowlist. Media/session/profile-only fields (video_url, cdn_url, cdn_link,
 * subtitle_url, tt_chain_token, secu_id, profile_biography, profile_avatar, comments,
 * tagged_user, music, …) are never read, so they cannot reach the database.
 */
import { UpstreamError, requestJson, type FetchLike } from '@vd/adapter-contract';
import type {
  TikTokProviderCallContext,
  TikTokProviderError,
  TikTokProviderResult,
  TikTokPublicPost,
  TikTokPublicProvider,
} from './provider.ts';

export const BRIGHTDATA_API_URL = 'https://api.brightdata.com';
/** Documented dataset id of "TikTok - Posts" (collect_by_url, discover_by_keyword). */
export const BRIGHTDATA_TIKTOK_POSTS_DATASET = 'gd_lu702nij2f790tmv9h';
const SERVICE = 'brightdata';

export interface BrightDataProviderOptions {
  token: string;
  fetch?: FetchLike;
  baseUrl?: string;
  datasetId?: string;
  /** Longest wait for one collection job (default 600 s). */
  maxWaitMs?: number;
  /** Delay between progress checks (default 10 s). */
  pollIntervalMs?: number;
  /** Injectable for tests; must honor the abort signal. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Clock for the wait deadline (tests). */
  now?: () => number;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });

// ── record mapping (allowlist) ────────────────────────────────────────────────

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** A non-negative count; numeric strings accepted ("share_count" is typed text). */
function count(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
  if (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) return Number(v.trim());
  return null;
}

function text(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function idText(v: unknown): string | null {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return String(v);
  const t = text(v);
  return t && /^\d{1,30}$/.test(t) ? t : null;
}

function isoTime(v: unknown): string | null {
  const t = typeof v === 'number' ? new Date(v > 1e12 ? v : v * 1000) : new Date(text(v) ?? NaN);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

function httpsUrl(v: unknown): string | null {
  const t = text(v);
  if (!t) return null;
  try {
    return new URL(t).protocol === 'https:' ? t : null;
  } catch {
    return null;
  }
}

const VIDEO_ID_IN_URL = /\/video\/(\d{1,30})(?:[/?#]|$)/;

/** Maps one Bright Data post record, or explains why it is not usable. */
export function mapBrightDataRecord(
  raw: unknown,
): { ok: true; post: TikTokPublicPost } | { ok: false; error: Omit<TikTokProviderError, 'input'> } {
  const r = asRecord(raw);
  if (!r)
    return { ok: false, error: { code: 'malformed_record', message: 'record is not an object' } };
  if (r['error'] !== undefined || r['error_code'] !== undefined) {
    return {
      ok: false,
      error: {
        code: text(r['error_code']) ?? 'provider_error',
        message: (text(r['error']) ?? 'provider reported an error').slice(0, 300),
      },
    };
  }
  const url = httpsUrl(r['url']);
  const videoId = idText(r['post_id']) ?? (url ? (VIDEO_ID_IN_URL.exec(url)?.[1] ?? null) : null);
  if (!videoId)
    return {
      ok: false,
      error: { code: 'malformed_record', message: 'record has no TikTok video id' },
    };
  const durationSeconds =
    typeof r['video_duration'] === 'number' && r['video_duration'] >= 0
      ? r['video_duration']
      : null;
  const rawType = text(r['post_type'])?.toLowerCase() ?? null;
  const carousel = Array.isArray(r['carousel_images']) && r['carousel_images'].length > 0;
  const postType: TikTokPublicPost['postType'] =
    rawType === 'video'
      ? 'video'
      : rawType === 'image' || rawType === 'carousel' || rawType === 'photo' || carousel
        ? 'image'
        : 'unknown';
  const hashtags = Array.isArray(r['hashtags'])
    ? [
        ...new Set(
          r['hashtags']
            .map((h) => text(h)?.replace(/^#/, ''))
            .filter((h): h is string => Boolean(h)),
        ),
      ]
    : [];
  return {
    ok: true,
    post: {
      videoId,
      url,
      creatorUsername: text(r['profile_username'])?.replace(/^@/, '') ?? null,
      creatorId: idText(r['profile_id']) ?? idText(r['account_id']),
      creatorDisplayName: null, // the posts dataset has no display-name field
      creatorFollowers: count(r['profile_followers']),
      caption: text(r['description']),
      publishedAt: isoTime(r['create_time']),
      durationSeconds,
      coverUrl: httpsUrl(r['preview_image']),
      views: count(r['play_count']),
      likes: count(r['digg_count']),
      comments: count(r['comment_count']),
      shares: count(r['num_share_count']) ?? count(r['share_count']),
      hashtags,
      postType,
    },
  };
}

/** The input a record answers (for error attribution), as Bright Data echoes it. */
function inputOf(raw: unknown): string | null {
  const r = asRecord(raw);
  const input = asRecord(r?.['input']) ?? asRecord(r?.['discovery_input']);
  return text(input?.['url']) ?? text(input?.['search_keyword']) ?? text(r?.['url']);
}

// ── provider ─────────────────────────────────────────────────────────────────

export function createBrightDataProvider(options: BrightDataProviderOptions): TikTokPublicProvider {
  if (!options.token) throw new Error('Bright Data provider needs BRIGHTDATA_API_TOKEN');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const base = (options.baseUrl ?? BRIGHTDATA_API_URL).replace(/\/+$/, '');
  const datasetId = options.datasetId ?? BRIGHTDATA_TIKTOK_POSTS_DATASET;
  const maxWaitMs = options.maxWaitMs ?? 600_000;
  const pollMs = options.pollIntervalMs ?? 10_000;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const headers = {
    Authorization: `Bearer ${options.token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  const call = (url: URL, ctx: TikTokProviderCallContext, init: RequestInit = {}) => {
    ctx.meter.request();
    return requestJson(url, {
      service: SERVICE,
      fetch: fetchImpl,
      signal: ctx.signal,
      timeoutMs: 60_000,
      init: { ...init, headers },
      classify: (status) =>
        status === 401 || status === 403
          ? { kind: 'unauthorized', detail: 'check BRIGHTDATA_API_TOKEN' }
          : status === 429
            ? { kind: 'rate_limited' }
            : undefined,
    });
  };

  /** trigger → wait until ready → download; returns raw records. */
  async function collect(
    input: Record<string, unknown>[],
    discover: boolean,
    ctx: TikTokProviderCallContext,
  ): Promise<unknown[]> {
    const trigger = new URL(`${base}/datasets/v3/trigger`);
    trigger.searchParams.set('dataset_id', datasetId);
    trigger.searchParams.set('include_errors', 'true');
    if (discover) {
      trigger.searchParams.set('type', 'discover_new');
      trigger.searchParams.set('discover_by', 'keyword');
    }
    const started = asRecord(
      await call(trigger, ctx, { method: 'POST', body: JSON.stringify({ input }) }),
    );
    const snapshotId = text(started?.['snapshot_id']);
    if (!snapshotId || !/^[A-Za-z0-9_-]{1,100}$/.test(snapshotId)) {
      throw new UpstreamError(SERVICE, 'invalid_response', 'trigger response has no snapshot_id');
    }
    const deadline = now() + maxWaitMs;
    for (;;) {
      const progress = asRecord(
        await call(new URL(`${base}/datasets/v3/progress/${snapshotId}`), ctx),
      );
      const status = text(progress?.['status']);
      if (status === 'ready') break;
      if (status === 'failed' || status === 'canceled') {
        throw new UpstreamError(SERVICE, 'server_error', `collection ${snapshotId} ${status}`);
      }
      if (now() + pollMs > deadline) {
        throw new UpstreamError(
          SERVICE,
          'timeout',
          `collection ${snapshotId} not ready after ${Math.round(maxWaitMs / 1000)} s`,
        );
      }
      await sleep(pollMs, ctx.signal);
    }
    const download = new URL(`${base}/datasets/v3/snapshot/${snapshotId}`);
    download.searchParams.set('format', 'json');
    const body = await call(download, ctx);
    if (!Array.isArray(body)) {
      throw new UpstreamError(SERVICE, 'invalid_response', 'snapshot is not a JSON array');
    }
    return body as unknown[];
  }

  function split(records: unknown[], fallbackInput: string): TikTokProviderResult {
    const result: TikTokProviderResult = { posts: [], errors: [] };
    for (const record of records) {
      const mapped = mapBrightDataRecord(record);
      if (mapped.ok) result.posts.push(mapped.post);
      else result.errors.push({ input: inputOf(record) ?? fallbackInput, ...mapped.error });
    }
    return result;
  }

  return {
    id: 'brightdata',
    displayName: 'Bright Data',
    maxLookupBatch: 100,

    async searchPosts(query, ctx) {
      const records = await collect(
        [
          {
            search_keyword: query.keyword,
            num_of_posts: query.limit,
            country: query.country ?? '',
          },
        ],
        true,
        ctx,
      );
      // Billing is per record: never pass on more than was asked for.
      const result = split(records, query.keyword);
      result.posts = result.posts.slice(0, query.limit);
      return result;
    },

    async lookupPosts(urls, ctx) {
      if (urls.length === 0) return { posts: [], errors: [] };
      const records = await collect(
        urls.map((url) => ({ url, country: '' })),
        false,
        ctx,
      );
      return split(records, 'lookup');
    },
  };
}
