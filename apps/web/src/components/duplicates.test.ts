import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type AnyDatabase } from '@vd/db';
import { createTestDb, seedVideo } from '@vd/dedupe/testing';
import type { ConflictView, DuplicateView, VersionView } from '@vd/review';

// Server-action plumbing that only exists inside Next.js.
const context: { db: AnyDatabase | null } = { db: null };
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../lib/server.ts', () => ({
  getContext: () => ({ db: context.db, logger: { error: vi.fn() } }),
}));

const { ConflictBanner, DuplicateIndicator, PossibleDuplicates, VersionsTable } =
  await import('./Duplicates.tsx');
const { confirmDuplicateAction, rejectDuplicateAction } = await import('../app/actions.ts');

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

const dup: DuplicateView = {
  candidateId: '11111111-1111-4111-8111-111111111111',
  otherClusterId: '22222222-2222-4222-8222-222222222222',
  href: '/candidates/22222222-2222-4222-8222-222222222222',
  platform: 'TikTok',
  title: 'this cat discovered the vacuum cleaner',
  creator: 'repost.daily',
  thumbnailUrl: null,
  duration: '—',
  canonicalUrl: 'https://www.tiktok.com/@repost.daily/video/7499999999999999999',
  confidence: 0.6,
  confidenceText: '60%',
  strength: 'Medium',
  evidence: ['Thumbnail: very close (distance 5/64)', 'Duration: unknown on at least one side'],
  needsHumanBecause: ['duration unknown on one side'],
  note: null,
  decidedAt: null,
};

describe('duplicate UI', () => {
  it('feed card indicator: small link to the detail section, plus confirmed versions', () => {
    const markup = html(
      createElement(DuplicateIndicator, {
        href: '/candidates/abc',
        label: '2 possible duplicates',
        versionPlatforms: ['TikTok', 'YouTube'],
      }),
    );
    expect(markup).toContain('href="/candidates/abc#duplicates"');
    expect(markup).toContain('⧉ 2 possible duplicates');
    expect(markup).toContain('TikTok + YouTube');
    expect(
      html(
        createElement(DuplicateIndicator, {
          href: '/x',
          label: null,
          versionPlatforms: ['YouTube'],
        }),
      ),
    ).toBe('');
  });

  it('detail section shows platform, title, duration, confidence, evidence, Open original and both actions', () => {
    const markup = html(createElement(PossibleDuplicates, { clusterId: 'c', duplicates: [dup] }));
    for (const text of [
      'TikTok',
      'this cat discovered the vacuum cleaner',
      'Similarity confidence <strong>60%</strong>',
      'Thumbnail: very close (distance 5/64)',
      'Not merged automatically: duration unknown on one side.',
      'href="https://www.tiktok.com/@repost.daily/video/7499999999999999999"',
      'Open original ↗',
      'Confirm same video',
      'Not the same',
      'no thumbnail',
    ]) {
      expect(markup).toContain(text);
    }
    expect(html(createElement(PossibleDuplicates, { clusterId: 'c', duplicates: [] }))).toContain(
      'No possible duplicates.',
    );
  });

  it('merged representations are shown as versions of one clip', () => {
    const versions: VersionView[] = [
      {
        videoId: 'v1',
        platform: 'YouTube',
        title: 'Cat discovers the vacuum cleaner',
        creator: 'Fixture Pets',
        duration: '0:42',
        canonicalUrl: 'https://www.youtube.com/watch?v=vdFixture01',
        thumbnailUrl: null,
        isRepresentative: true,
        joined: 'exact identity',
      },
      {
        videoId: 'v2',
        platform: 'Twitch',
        title: 'cat discovers vacuum cleaner LOL',
        creator: 'FixturePets',
        duration: '0:42',
        canonicalUrl: 'https://clips.twitch.tv/CatClip',
        thumbnailUrl: null,
        isRepresentative: false,
        joined: 'auto-confirmed same as YouTube (confidence 0.99)',
      },
    ];
    const markup = html(createElement(VersionsTable, { versions }));
    expect(markup).toContain('2 confirmed representations of the same underlying clip');
    expect(markup).toContain('not separate discoveries');
    expect(markup).toContain('representative');
    expect(markup).toContain('auto-confirmed same as YouTube (confidence 0.99)');
  });

  it('conflict warning lists each side and asks for a decision', () => {
    const conflicts: ConflictView[] = [
      {
        kind: 'review',
        title:
          'Review conflict — merged versions had different decisions. Choose a decision to resolve it.',
        reason: 'different decisions (approved vs rejected)',
        sides: [
          { versions: 'YouTube', value: 'Approved' },
          { versions: 'TikTok', value: 'Rejected' },
        ],
      },
    ];
    const markup = html(createElement(ConflictBanner, { conflicts }));
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Review conflict');
    expect(markup).toContain('YouTube version: <strong>Approved</strong>');
    expect(markup).toContain('TikTok version: <strong>Rejected</strong>');
    expect(html(createElement(ConflictBanner, { conflicts: [] }))).toBe('');
  });
});

describe('duplicate server actions', () => {
  let close: () => Promise<void>;
  let pair: string;
  let yt: { clusterId: string; videoId: string };
  let tt: { clusterId: string; videoId: string };
  beforeEach(async () => {
    const t = await createTestDb();
    context.db = t.db;
    close = t.close;
    yt = await seedVideo(t.db, {
      platform: 'youtube',
      platformVideoId: 'a',
      title: 'cat vacuum',
      durationMs: 42_000,
    });
    tt = await seedVideo(t.db, { platform: 'tiktok', platformVideoId: '1', title: 'cat vacuum' });
    const [a, b] = [yt.videoId, tt.videoId].sort() as [string, string];
    const [row] = await t.db
      .insert(schema.duplicateCandidates)
      .values({ videoAId: a, videoBId: b, confidence: 0.6, detectorVersion: 'near-dup-v1' })
      .returning();
    pair = row!.id;
  });
  afterEach(async () => {
    await close();
  });

  it('confirm merges and points the page at the surviving candidate', async () => {
    const r = await confirmDuplicateAction(pair, tt.clusterId);
    expect(r).toMatchObject({ ok: true, message: 'merged' });
    const tiktok = (await context.db!.select().from(schema.videos)).find(
      (v) => v.id === tt.videoId,
    );
    expect(r.ok && r.redirectTo).toBe(`/candidates/${tiktok!.clusterId!}`);
  });

  it('reject is recorded; errors come back as messages, not exceptions', async () => {
    expect(await rejectDuplicateAction(pair, yt.clusterId)).toEqual({
      ok: true,
      message: 'marked not the same',
    });
    const [row] = await context.db!.select().from(schema.duplicateCandidates);
    expect(row!.status).toBe('rejected');
    expect(await rejectDuplicateAction('not-an-id', yt.clusterId)).toEqual({
      ok: false,
      error: 'invalid duplicate id',
    });
  });
});
