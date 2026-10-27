import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type AnyDatabase } from '@vd/db';
import { confirmDuplicate } from '@vd/dedupe';
import { getFeed, setSaved, toCardView, type CardView, type DiscoveryHealth } from '@vd/review';
import { NOW, ROLES, createTestDb, hoursAgo, seedCandidate, seedFeed } from '@vd/review/testing';

const context: { db: AnyDatabase | null } = { db: null };
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../lib/server.ts', () => ({
  getContext: () => ({ db: context.db, config: {}, logger: { error: vi.fn() } }),
}));

const { CandidateCard } = await import('./CandidateCard.tsx');
const { InboxActions } = await import('./InboxActions.tsx');
const { Representations, RepresentationList, StateBadges } = await import('./Representations.tsx');
const { SourceHealthTable } = await import('./SourceHealth.tsx');
const { GET } = await import('../app/export/route.ts');

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

let close: () => Promise<void>;
let seeded: Awaited<ReturnType<typeof seedFeed>>;
beforeEach(async () => {
  const t = await createTestDb();
  context.db = t.db;
  close = t.close;
  seeded = await seedFeed(t.db);
});
afterEach(async () => {
  await close();
});

const cardFor = async (clusterId: string): Promise<CardView> => {
  const row = (await getFeed(context.db!, { now: NOW, pageSize: 100 })).items.find(
    (i) => i.clusterId === clusterId,
  );
  return toCardView(row!, ROLES, NOW);
};

describe('inbox card', () => {
  it('shows thumbnail, title, creator, platform, age, score, labels, metrics, and Open original', async () => {
    const markup = html(
      createElement(CandidateCard, { card: await cardFor(seeded.breakout.clusterId) }),
    );
    for (const text of [
      'Cat discovers the vacuum cleaner',
      'Fixture Pets',
      'YouTube',
      '11h',
      '94',
      'animals',
      '190k views · 15.5k likes · 910 comments',
      'Rights: Unknown',
      '▶ Open original on YouTube ↗',
      'href="https://example.test/youtube/vdFixture01"',
      'data-select-cluster',
      '☆ Save',
      '⬇ Obtained?',
      'Approve',
      'Reject',
      'Details →',
    ]) {
      expect(markup).toContain(text);
    }
  });

  it('works without a thumbnail or metrics', async () => {
    const twitch = html(
      createElement(CandidateCard, { card: await cardFor(seeded.provisional.clusterId) }),
    );
    expect(twitch).toContain('no thumbnail');
    const tiktok = html(
      createElement(CandidateCard, { card: await cardFor(seeded.insufficient.clusterId) }),
    );
    expect(tiktok).toContain('no canonical metrics');
    expect(tiktok).toContain('▶ Open original on TikTok ↗');
  });

  it('shows Saved / Obtained / Used state and alternate representations', async () => {
    const repost = await seedCandidate(context.db!, {
      platform: 'tiktok',
      platformVideoId: '7422222222222222222',
      title: 'cat vacuum repost',
      firstDiscoveredAt: hoursAgo(1),
      sightings: [{ source: 'manual-url', key: 'tiktok:7422222222222222222', at: hoursAgo(1) }],
    });
    const [a, b] = [seeded.breakout.videoId, repost.videoId].sort() as [string, string];
    const [pair] = await context
      .db!.insert(schema.duplicateCandidates)
      .values({ videoAId: a, videoBId: b, confidence: 0.7, detectorVersion: 'near-dup-v1' })
      .returning();
    await confirmDuplicate(context.db!, pair!.id, { now: NOW });
    await setSaved(context.db!, { clusterId: seeded.breakout.clusterId, saved: true });
    await context.db!.insert(schema.acquisitionEvents).values({
      clusterId: seeded.breakout.clusterId,
      status: 'obtained',
    });
    const card = await cardFor(seeded.breakout.clusterId);
    const markup = html(createElement(CandidateCard, { card }));
    expect(markup).toContain('★ Saved');
    expect(markup).toContain('⬇ Obtained');
    expect(markup).toContain('Also on');
    expect(markup).toContain('href="https://example.test/tiktok/7422222222222222222"');
    expect(markup).toContain('TikTok + YouTube');
  });
});

describe('inbox components', () => {
  it('actions reflect state (pressed buttons) and the obtained note field', () => {
    const markup = html(
      createElement(InboxActions, {
        clusterId: 'c',
        state: { saved: true, obtained: true, used: false, approved: false, rejected: false },
        withNote: true,
      }),
    );
    expect(markup).toContain('★ Saved');
    expect(markup).toContain('⬇ Obtained');
    expect(markup.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(markup).toContain('Obtained note');
    const used = html(
      createElement(InboxActions, {
        clusterId: 'c',
        state: { saved: false, obtained: false, used: true, approved: false, rejected: false },
      }),
    );
    expect(used).toContain('✓ Used');
  });

  it('never presents a source link as a download', () => {
    const reps = [
      {
        videoId: 'v1',
        platform: 'YouTube',
        url: 'https://y.test/1',
        creator: 'A',
        isRepresentative: true,
        mediaDownload: false,
      },
      {
        videoId: 'v2',
        platform: 'Twitch',
        url: 'https://t.test/2',
        creator: null,
        isRepresentative: false,
        mediaDownload: false,
      },
    ];
    const access = {
      sourceLink: true as const,
      mediaDownload: false,
      label: 'Source link only (no official download)',
    };
    const markup = html(
      createElement(Representations, {
        clusterId: 'c',
        representations: reps,
        canonicalUrl: 'https://y.test/1',
        platform: 'YouTube',
        access,
      }),
    );
    expect(markup).toContain('Source link only (no official download)');
    expect(markup).not.toMatch(/download available/);
    expect(markup).toContain('Download unavailable');
    expect(markup).toContain('No downloadable media asset is available for this video.');
    expect(markup).not.toContain('/api/candidates/c/download');
    const list = html(createElement(RepresentationList, { clusterId: 'c', representations: reps }));
    expect(list).toContain('YouTube');
    expect(list).toContain('Twitch');
    expect(list.match(/source link only/g)).toHaveLength(2);
    expect(
      html(
        createElement(RepresentationList, {
          clusterId: 'c',
          representations: [{ ...reps[0]!, mediaDownload: true }],
        }),
      ),
    ).toContain('official download available');
  });

  it('state badges', () => {
    const inbox = {
      saved: false,
      approved: false,
      rejected: false,
      used: true,
      obtained: true,
      obtainedAt: null,
      obtainedNote: null,
    };
    const markup = html(createElement(StateBadges, { inbox, conflict: false }));
    expect(markup).toContain('✓ Already used');
    expect(markup).toContain('⬇ Obtained');
  });

  it('discovery health shows unconfigured adapters, failures, quota, and planned sources', () => {
    const source = {
      sourceId: 's1',
      name: 'youtube-main',
      enabled: true,
      enabledQueries: 2,
      state: 'failing' as const,
      lastSuccessAt: hoursAgo(30),
      lastRunAt: hoursAgo(1),
      lastRunStatus: 'failed',
      lastError: 'quota exhausted for search.list',
      lastErrorAt: hoursAgo(1),
      runs24h: 3,
      found24h: 50,
      new24h: 9,
      quarantined24h: 1,
      quota: [{ bucket: 'search.list', used: 100, budget: 100 }],
    };
    const health: DiscoveryHealth = {
      adapters: [
        {
          id: 'youtube',
          displayName: 'YouTube',
          platform: 'youtube',
          configured: true,
          missingEnv: [],
          sources: [source],
        },
        {
          id: 'twitch',
          displayName: 'Twitch',
          platform: 'twitch',
          configured: false,
          missingEnv: ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET'],
          sources: [],
        },
      ],
      planned: [{ id: 'reddit', reason: 'Data API access requires Reddit approval' }],
      orphanSources: [],
      pipeline: {
        videosDiscovered24h: 9,
        lastScoredAt: null,
        lastDuplicateScanAt: null,
        lastClassifiedAt: null,
        unprocessedForDuplicates: 0,
      },
    };
    const markup = html(createElement(SourceHealthTable, { health }));
    expect(markup).toContain('✖ failing');
    expect(markup).toContain('quota exhausted for search.list');
    expect(markup).toContain('search.list: 100 / 100');
    expect(markup).toContain('3 runs · 50 found · 9 new');
    expect(markup).toContain('not configured — set TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET');
    expect(markup).toContain('No sources stored for this adapter yet.');
    expect(markup).toContain('reddit: planned, not implemented');
  });
});

describe('export route', () => {
  it('exports selected ids as CSV with attachment headers', async () => {
    const res = await GET(
      new Request(
        `http://local/export?format=csv&ids=${seeded.breakout.clusterId},${seeded.provisional.clusterId}`,
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/csv/);
    expect(res.headers.get('content-disposition')).toMatch(
      /attachment; filename="viral-inbox-\d+\.csv"/,
    );
    const lines = (await res.text()).trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^Cat discovers the vacuum cleaner,Fixture Pets/);
  });

  it('exports a view as JSON, and rejects junk ids', async () => {
    await setSaved(context.db!, { clusterId: seeded.provisional.clusterId, saved: true });
    const res = await GET(new Request('http://local/export?format=json&view=saved'));
    const body = (await res.json()) as { count: number; candidates: { title: string }[] };
    expect(body.count).toBe(1);
    expect(body.candidates[0]!.title).toBe('chat made me do it');
    expect((await GET(new Request('http://local/export?ids=1;drop table videos'))).status).toBe(
      400,
    );
  });
});
