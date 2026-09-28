import { rejected, type PlatformResolver, type UrlResolution } from './types.ts';

const HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);
const SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be']);
/** YouTube video ids are 11 characters of [A-Za-z0-9_-]. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
/** Path prefixes whose next segment is the video id. */
const PATH_KINDS: Record<string, string> = {
  shorts: 'short',
  embed: 'embed',
  live: 'live',
  v: 'embed',
  e: 'embed',
};

export function youtubeCanonicalUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function resolved(id: string | null | undefined, kind: string): UrlResolution {
  if (!id || !VIDEO_ID.test(id)) {
    return rejected('unsupported_path', 'not a valid YouTube video id', 'youtube');
  }
  return {
    ok: true,
    platform: 'youtube',
    platformVideoId: id,
    canonicalUrl: youtubeCanonicalUrl(id),
    kind,
  };
}

export const resolveYouTube: PlatformResolver = (url) => {
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);

  if (SHORT_HOSTS.has(host)) return resolved(segments[0], 'short_link');
  if (!HOSTS.has(host)) return null;

  const [first, second] = segments;
  if (first === 'watch') return resolved(url.searchParams.get('v'), 'watch');
  if (first !== undefined && first in PATH_KINDS) return resolved(second, PATH_KINDS[first] ?? '');
  return rejected(
    'unsupported_path',
    'recognized YouTube host, but not a video URL (channels, playlists, and search pages are not videos)',
    'youtube',
  );
};
