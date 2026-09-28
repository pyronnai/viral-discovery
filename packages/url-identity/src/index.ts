import { resolveTikTok } from './tiktok.ts';
import { resolveTwitch } from './twitch.ts';
import { rejected, type PlatformResolver, type UrlResolution } from './types.ts';
import { resolveYouTube } from './youtube.ts';

export * from './types.ts';
export { youtubeCanonicalUrl } from './youtube.ts';
export { twitchClipCanonicalUrl } from './twitch.ts';

const RESOLVERS: readonly PlatformResolver[] = [resolveYouTube, resolveTikTok, resolveTwitch];

/**
 * Maps a video URL to its canonical identity (platform + platform video id).
 * Pure: never performs network requests, never follows redirects, never guesses.
 * Unknown URLs are rejected with a reason instead.
 */
export function resolveVideoUrl(input: string): UrlResolution {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return rejected('invalid_url', `not a URL: "${trimmed.slice(0, 200)}"`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return rejected('invalid_url', `unsupported scheme "${url.protocol}"`);
  }
  for (const resolve of RESOLVERS) {
    const result = resolve(url);
    if (result) return result;
  }
  return rejected(
    'unsupported_host',
    `unsupported host "${url.hostname}" (supported: YouTube, TikTok, Twitch clips)`,
  );
}
