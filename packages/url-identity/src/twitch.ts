import { rejected, type PlatformResolver, type UrlResolution } from './types.ts';

const CLIP_HOSTS = new Set(['clips.twitch.tv']);
const CHANNEL_HOSTS = new Set(['twitch.tv', 'www.twitch.tv', 'm.twitch.tv']);
/** Clip slugs are case-sensitive words, optionally followed by a "-suffix". */
const SLUG = /^[A-Za-z0-9_-]{3,100}$/;

export function twitchClipCanonicalUrl(slug: string): string {
  return `https://clips.twitch.tv/${slug}`;
}

function clip(slug: string | null | undefined): UrlResolution {
  if (!slug || !SLUG.test(slug)) {
    return rejected('unsupported_path', 'not a valid Twitch clip id', 'twitch');
  }
  return {
    ok: true,
    platform: 'twitch',
    platformVideoId: slug,
    canonicalUrl: twitchClipCanonicalUrl(slug),
    kind: 'clip',
  };
}

/** Twitch clips only. VODs and live channels are not supported sources of videos yet. */
export const resolveTwitch: PlatformResolver = (url) => {
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);

  if (CLIP_HOSTS.has(host)) {
    if (segments[0] === 'embed') return clip(url.searchParams.get('clip'));
    return clip(segments[0]);
  }
  if (!CHANNEL_HOSTS.has(host)) return null;
  if (segments.length >= 3 && segments[1] === 'clip') return clip(segments[2]);
  return rejected(
    'unsupported_path',
    'only Twitch clip URLs are supported (clips.twitch.tv/<id> or twitch.tv/<channel>/clip/<id>)',
    'twitch',
  );
};
