import { rejected, type PlatformResolver } from './types.ts';

const HOSTS = new Set(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com']);
const SHORT_HOSTS = new Set(['vm.tiktok.com', 'vt.tiktok.com']);
const VIDEO_ID = /^\d{5,25}$/;
const HANDLE = /^@[A-Za-z0-9._]{1,64}$/;

/**
 * Only the documented form `https://www.tiktok.com/@{handle}/video/{id}` resolves
 * (it is the format in TikTok's oEmbed documentation). Short/share links are
 * recognized (reason "short_link") but this package never follows them — that
 * network step lives in @vd/url-resolution. Other shapes are rejected, not guessed.
 */
export const resolveTikTok: PlatformResolver = (url) => {
  const host = url.hostname.toLowerCase();
  if (SHORT_HOSTS.has(host) || (HOSTS.has(host) && url.pathname.startsWith('/t/'))) {
    return rejected(
      'short_link',
      'TikTok short link: it has no video id until its redirect is expanded (network step, see @vd/url-resolution)',
      'tiktok',
    );
  }
  if (!HOSTS.has(host)) return null;

  const [handle, type, id] = url.pathname.split('/').filter(Boolean);
  if (handle && HANDLE.test(handle) && type === 'video' && id && VIDEO_ID.test(id)) {
    return {
      ok: true,
      platform: 'tiktok',
      platformVideoId: id,
      canonicalUrl: `https://www.tiktok.com/${handle}/video/${id}`,
      kind: 'video',
    };
  }
  if (type === 'photo') {
    return rejected('unsupported_path', 'TikTok photo posts are not videos', 'tiktok');
  }
  return rejected(
    'unsupported_path',
    'expected a TikTok video URL of the form https://www.tiktok.com/@user/video/<id>',
    'tiktok',
  );
};
