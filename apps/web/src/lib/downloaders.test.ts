import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DOWNLOADER_PROVIDERS,
  NO_DOWNLOADER_MESSAGE,
  copyText,
  downloadersFor,
  handoffFor,
  providerById,
} from './downloaders.ts';

const TIKTOK = 'https://www.tiktok.com/@someone/video/7411111111111111111';

describe('downloader provider configuration', () => {
  it('is the single verified source of downloader websites', () => {
    for (const p of DOWNLOADER_PROVIDERS) {
      const url = new URL(p.website);
      expect(url.protocol).toBe('https:');
      expect(url.search).toBe('');
      expect(url.hash).toBe('');
      expect(url.username).toBe('');
      expect(p.verification.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.verification.evidence.length).toBeGreaterThan(40);
      // No prefill is documented by any of these services; none may be invented.
      expect(p.prefill).toBeNull();
      if (!p.webTool) expect(p.platforms).toEqual([]);
    }
    expect(providerById('snaptik')?.website).toBe('https://snaptik.app/');
    expect(providerById('snapinsta')?.website).toBe('https://snapinsta.to/');
    expect(providerById('snaptube')?.website).toBe('https://www.snaptube.com/');
    expect(providerById('nope')).toBeNull();
  });

  it('maps TikTok → SnapTik', () => {
    expect(downloadersFor('tiktok').map((p) => p.id)).toEqual(['snaptik']);
    expect(downloadersFor('TikTok ').map((p) => p.id)).toEqual(['snaptik']);
  });

  it('offers no Instagram handoff while the SnapInsta domain is unverified', () => {
    expect(downloadersFor('instagram')).toEqual([]);
    const snapinsta = providerById('snapinsta')!;
    expect(snapinsta.webTool).toBe(false);
    expect(snapinsta.platforms).toEqual([]);
    expect(snapinsta.verification.status).toBe('unconfirmed');
  });

  it('invents nothing for platforms without a verified web tool', () => {
    for (const platform of [
      'youtube',
      'twitch',
      'bluesky',
      'instagram',
      'manual',
      'reddit',
      '',
      'snaptik',
    ])
      expect(downloadersFor(platform), platform).toEqual([]);
    // SnapTube is configured (so its status is recorded) but offers no verified web tool.
    const snaptube = providerById('snaptube')!;
    expect(snaptube.webTool).toBe(false);
    expect(downloadersFor('tiktok').map((p) => p.id)).not.toContain('snaptube');
    expect(NO_DOWNLOADER_MESSAGE).toBe('No configured external downloader for this platform.');
  });

  it('prepares the exact canonical URL and opens only the configured website', () => {
    const snaptik = providerById('snaptik')!;
    const h = handoffFor(snaptik, TIKTOK);
    expect(h.copyText).toBe(TIKTOK);
    expect(h.href).toBe('https://snaptik.app/');
    expect(h.copiedMessage).toBe('Video link copied — paste it into SnapTik.');
  });

  it('lets no candidate-controlled value alter the downloader hostname', () => {
    const snaptik = providerById('snaptik')!;
    for (const hostile of [
      'https://evil.example/?u=https://snaptik.app/',
      'javascript:alert(1)',
      '//evil.example/snaptik.app',
      'https://snaptik.app.evil.example/video/1',
      '\u0000https://evil.example',
      '',
    ]) {
      const h = handoffFor(snaptik, hostile);
      expect(h.href).toBe('https://snaptik.app/');
      expect(new URL(h.href).hostname).toBe('snaptik.app');
      expect(h.copyText).toBe(hostile); // copied verbatim, never interpolated into the href
    }
  });

  it('reports clipboard failure instead of throwing', async () => {
    const write = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    expect(await copyText(TIKTOK, write)).toBe(false);
    expect(await copyText(TIKTOK, undefined)).toBe(false);
    const ok = vi.fn().mockResolvedValue(undefined);
    expect(await copyText(TIKTOK, ok)).toBe(true);
    expect(ok).toHaveBeenCalledWith(TIKTOK);
  });

  it('never proxies, fetches or routes an external downloader through the backend', () => {
    const src = readFileSync(path.join(import.meta.dirname, 'downloaders.ts'), 'utf8');
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/from 'node:|from '@vd\/db'|from 'drizzle-orm'/);
    const apiRoot = path.join(import.meta.dirname, '..', 'app', 'api');
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
      );
    for (const file of walk(apiRoot)) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(
        /snaptik|snapinsta|snaptube|downloaders/i,
      );
    }
  });
});
