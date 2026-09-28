import { describe, expect, it } from 'vitest';
import { resolveVideoUrl } from './index.ts';

const YT = 'dQw4w9WgXcQ';
const YT_CANON = `https://www.youtube.com/watch?v=${YT}`;

describe('resolveVideoUrl: YouTube', () => {
  it.each([
    [`https://www.youtube.com/watch?v=${YT}`, 'watch'],
    [`https://youtube.com/watch?v=${YT}&t=42s&si=track`, 'watch'],
    [`https://m.youtube.com/watch?feature=share&v=${YT}`, 'watch'],
    [`http://www.youtube.com/watch?v=${YT}`, 'watch'],
    [`www.youtube.com/watch?v=${YT}`, 'watch'],
    [`https://music.youtube.com/watch?v=${YT}&list=RD`, 'watch'],
    [`https://youtu.be/${YT}`, 'short_link'],
    [`https://youtu.be/${YT}?si=abc&t=10`, 'short_link'],
    [`youtu.be/${YT}`, 'short_link'],
    [`https://www.youtube.com/shorts/${YT}`, 'short'],
    [`https://youtube.com/shorts/${YT}?is=pesN3OPZd5PW3Skj`, 'short'],
    [`https://m.youtube.com/shorts/${YT}/`, 'short'],
    [`https://www.youtube.com/embed/${YT}?autoplay=1`, 'embed'],
    [`https://www.youtube-nocookie.com/embed/${YT}`, 'embed'],
    [`https://www.youtube.com/live/${YT}`, 'live'],
    [`  https://WWW.YOUTUBE.COM/watch?v=${YT}  `, 'watch'],
  ])('%s → %s', (input, kind) => {
    expect(resolveVideoUrl(input)).toEqual({
      ok: true,
      platform: 'youtube',
      platformVideoId: YT,
      canonicalUrl: YT_CANON,
      kind,
    });
  });

  it('maps every variant of one video to the same identity', () => {
    const ids = new Set(
      [`https://youtu.be/${YT}`, `https://www.youtube.com/shorts/${YT}`, YT_CANON].map((u) => {
        const r = resolveVideoUrl(u);
        return r.ok ? `${r.platform}:${r.platformVideoId}:${r.canonicalUrl}` : 'rejected';
      }),
    );
    expect(ids.size).toBe(1);
  });

  it.each([
    'https://www.youtube.com/@SomeChannel',
    'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv',
    'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/watch',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQextra',
    'https://www.youtube.com/shorts/',
    'https://youtu.be/',
    'https://www.youtube.com/results?search_query=cats',
  ])('rejects non-video YouTube URL %s', (input) => {
    const r = resolveVideoUrl(input);
    expect(r).toMatchObject({ ok: false, reason: 'unsupported_path', platform: 'youtube' });
  });
});

describe('resolveVideoUrl: TikTok', () => {
  const ID = '7412345678901234567';
  it.each([
    `https://www.tiktok.com/@some.user_1/video/${ID}`,
    `https://www.tiktok.com/@some.user_1/video/${ID}?is_from_webapp=1&sender_device=pc`,
    `https://tiktok.com/@some.user_1/video/${ID}/`,
    `https://m.tiktok.com/@some.user_1/video/${ID}`,
  ])('%s', (input) => {
    expect(resolveVideoUrl(input)).toEqual({
      ok: true,
      platform: 'tiktok',
      platformVideoId: ID,
      canonicalUrl: `https://www.tiktok.com/@some.user_1/video/${ID}`,
      kind: 'video',
    });
  });

  it.each([
    'https://vm.tiktok.com/ZMabc123/',
    'https://vt.tiktok.com/ZSabc/',
    'https://www.tiktok.com/t/ZTabc/',
  ])('rejects short link %s with guidance instead of following it', (input) => {
    const r = resolveVideoUrl(input);
    expect(r).toMatchObject({ ok: false, reason: 'short_link', platform: 'tiktok' });
    if (!r.ok) expect(r.message).toMatch(/paste the full/);
  });

  it.each([
    `https://www.tiktok.com/@some.user/photo/${ID}`,
    'https://www.tiktok.com/@some.user',
    `https://www.tiktok.com/@some.user/video/not-a-number`,
    `https://www.tiktok.com/video/${ID}`,
    'https://www.tiktok.com/tag/funny',
  ])('rejects %s', (input) => {
    expect(resolveVideoUrl(input)).toMatchObject({
      ok: false,
      reason: 'unsupported_path',
      platform: 'tiktok',
    });
  });
});

describe('resolveVideoUrl: Twitch', () => {
  const SLUG = 'AwkwardHelplessSalamanderSwiftRage-a1B2c3D4e5F6g7H8';
  it.each([
    `https://clips.twitch.tv/${SLUG}`,
    `https://clips.twitch.tv/${SLUG}?tt_medium=clips_api`,
    `https://clips.twitch.tv/embed?clip=${SLUG}&parent=example.com`,
    `https://www.twitch.tv/somechannel/clip/${SLUG}`,
    `https://m.twitch.tv/somechannel/clip/${SLUG}?filter=clips`,
    `https://twitch.tv/somechannel/clip/${SLUG}`,
  ])('%s', (input) => {
    expect(resolveVideoUrl(input)).toEqual({
      ok: true,
      platform: 'twitch',
      platformVideoId: SLUG,
      canonicalUrl: `https://clips.twitch.tv/${SLUG}`,
      kind: 'clip',
    });
  });

  it('keeps clip ids case-sensitive', () => {
    const r = resolveVideoUrl('https://clips.twitch.tv/FunnyClipSlug');
    expect(r.ok && r.platformVideoId).toBe('FunnyClipSlug');
  });

  it.each([
    'https://www.twitch.tv/somechannel',
    'https://www.twitch.tv/videos/2233445566',
    'https://www.twitch.tv/somechannel/clip/',
    'https://clips.twitch.tv/embed',
  ])('rejects %s', (input) => {
    expect(resolveVideoUrl(input)).toMatchObject({
      ok: false,
      reason: 'unsupported_path',
      platform: 'twitch',
    });
  });
});

describe('resolveVideoUrl: unsupported input', () => {
  it.each([
    ['', 'invalid_url'],
    ['not a url at all', 'invalid_url'],
    ['ftp://www.youtube.com/watch?v=dQw4w9WgXcQ', 'invalid_url'],
    ['javascript:alert(1)', 'invalid_url'],
    ['https://www.instagram.com/reel/Cabc123/', 'unsupported_host'],
    ['https://vimeo.com/123456', 'unsupported_host'],
    ['https://notyoutube.com/watch?v=dQw4w9WgXcQ', 'unsupported_host'],
    ['https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ', 'unsupported_host'],
    ['https://bsky.app/profile/someone.bsky.social/post/3abc', 'unsupported_host'],
  ])('%j → %s', (input, reason) => {
    const r = resolveVideoUrl(input);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe(reason);
      expect(r.platform).toBeUndefined();
    }
  });
});
