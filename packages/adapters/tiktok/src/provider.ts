/**
 * Provider-neutral contract for PUBLIC TikTok data. The TikTok adapter (and the
 * rest of the application) only ever sees these shapes; each provider's own
 * response format ends at its implementation (e.g. brightdata.ts).
 *
 * Only public video metadata needed for discovery and ranking. Never: media
 * files or media URLs, private/profile-only data (bios, avatars, contact data),
 * other users' comments, or session tokens.
 */
import type { FetchLike } from '@vd/adapter-contract';

/** One public TikTok video as any provider must report it. Unknown = null, never guessed. */
export interface TikTokPublicPost {
  /** TikTok's numeric video id. */
  videoId: string;
  /** Public TikTok URL of the video (https://www.tiktok.com/@user/video/<id>). */
  url: string | null;
  creatorUsername: string | null;
  /** Public numeric account id, when the provider reports it. */
  creatorId: string | null;
  creatorDisplayName: string | null;
  creatorFollowers: number | null;
  caption: string | null;
  /** ISO-8601 publish time. */
  publishedAt: string | null;
  durationSeconds: number | null;
  /** Public cover / preview image (thumbnail only, never media). */
  coverUrl: string | null;
  /** null = not reported. 0 only when the provider explicitly reports zero. */
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  hashtags: string[];
  /** "video" is the only kind the application ingests; others are quarantined. */
  postType: 'video' | 'image' | 'unknown';
}

/** A per-input failure the provider reported (dead page, private, blocked, …). */
export interface TikTokProviderError {
  /** The keyword or URL the failure belongs to. */
  input: string;
  code: string | null;
  message: string;
}

export interface TikTokProviderResult {
  posts: TikTokPublicPost[];
  errors: TikTokProviderError[];
}

/** Metering hooks: the adapter turns these into quota accounting. */
export interface TikTokProviderMeter {
  /** Called before every HTTP request the provider makes. */
  request(): void;
}

export interface TikTokProviderCallContext {
  signal: AbortSignal;
  meter: TikTokProviderMeter;
}

export interface TikTokPublicProvider {
  /** Stable id, e.g. "brightdata". */
  readonly id: string;
  readonly displayName: string;
  /** Public posts for a keyword/hashtag search, at most `limit`. */
  searchPosts(
    query: { keyword: string; limit: number; country: string | null },
    ctx: TikTokProviderCallContext,
  ): Promise<TikTokProviderResult>;
  /** Current public data for known videos (lookup and metric refresh), by public URL. */
  lookupPosts(
    urls: readonly string[],
    ctx: TikTokProviderCallContext,
  ): Promise<TikTokProviderResult>;
  /** Largest number of URLs one lookupPosts call should carry. */
  readonly maxLookupBatch: number;
}

export interface TikTokProviderOptions {
  fetch?: FetchLike;
}
