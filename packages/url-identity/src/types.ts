/** Platforms whose video URLs this package can canonicalize. */
export const SUPPORTED_URL_PLATFORMS = ['youtube', 'tiktok', 'twitch'] as const;
export type UrlPlatform = (typeof SUPPORTED_URL_PLATFORMS)[number];

export interface ResolvedVideoUrl {
  ok: true;
  platform: UrlPlatform;
  /** The platform's own id for the video. Always determinable for a successful resolution. */
  platformVideoId: string;
  /** One stable URL per video, rebuilt from the id (tracking parameters are dropped). */
  canonicalUrl: string;
  /** Which URL shape was recognized, e.g. "watch", "short", "clip". Informational only. */
  kind: string;
}

export type UrlRejectionReason =
  | 'invalid_url' // not an http(s) URL at all
  | 'unsupported_host' // a host we do not recognize
  | 'unsupported_path' // a recognized host, but not a supported video URL (channel, playlist, photo, VOD, …)
  | 'short_link'; // a redirecting short link; resolving it would require fetching the page

export interface RejectedVideoUrl {
  ok: false;
  reason: UrlRejectionReason;
  /** Set when the host was recognized. */
  platform?: UrlPlatform;
  message: string;
}

export type UrlResolution = ResolvedVideoUrl | RejectedVideoUrl;

export type PlatformResolver = (url: URL) => UrlResolution | null;

export function rejected(
  reason: UrlRejectionReason,
  message: string,
  platform?: UrlPlatform,
): RejectedVideoUrl {
  return platform ? { ok: false, reason, platform, message } : { ok: false, reason, message };
}
