import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { PROMPT_VERSION, TAXONOMY_VERSION } from '@vd/classification';
import { schema, type AnyDatabase } from '@vd/db';
import { ReviewError, recordReview, setRights } from './actions.ts';
import { getCandidate } from './detail.ts';
import { decodeCursor, getFeed, getSummary, type FeedRow } from './feed.ts';
import { formatCount, growthSeries, toCardView } from './present.ts';
import { NOW, ROLES, createTestDb, hoursAgo, seedCandidate, seedFeed } from './testing.ts';

let db: AnyDatabase;
let close: () => Promise<void>;
let seeded: Awaited<ReturnType<typeof seedFeed>>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  seeded = await seedFeed(db);
});
afterEach(async () => {
  await close();
});

const ids = (items: FeedRow[]) => items.map((i) => i.clusterId);

describe('feed ordering', () => {
  it('scored (by score) → provisional → insufficient evidence → unscored', async () => {
    const { items } = await getFeed(db, { now: NOW });
    expect(ids(items)).toEqual([
      seeded.breakout.clusterId,
      seeded.lower.clusterId,
      seeded.provisional.clusterId,
      seeded.insufficient.clusterId,
      seeded.unscored.clusterId,
    ]);
    expect(items.map((i) => i.scoreState)).toEqual([
      'scored',
      'scored',
      'provisional',
      'insufficient_evidence',
      null,
    ]);
    expect(items[0]!.score!).toBeGreaterThan(items[1]!.score!);
  });

  it('never treats a NULL score as zero', async () => {
    const { items } = await getFeed(db, { now: NOW });
    const insufficient = items.find((i) => i.clusterId === seeded.insufficient.clusterId)!;
    expect(insufficient.score).toBeNull();
    const card = toCardView(insufficient, ROLES, NOW);
    expect(card.score).toMatchObject({
      text: '—',
      value: null,
      stateLabel: 'INSUFFICIENT EVIDENCE',
    });
  });

  it('paginates with a stable cursor and no duplicates or gaps', async () => {
    const all = ids((await getFeed(db, { now: NOW })).items);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const r = await getFeed(db, { now: NOW, pageSize: 2, cursor });
      seen.push(...ids(r.items));
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(all);
    expect(decodeCursor('garbage')).toBeNull();
    // A malformed cursor is ignored (first page), never an error.
    expect(
      ids((await getFeed(db, { now: NOW, pageSize: 2, cursor: 'not-a-cursor' })).items),
    ).toEqual(all.slice(0, 2));
  });
});

describe('feed filters', () => {
  const only = async (filters: Parameters<typeof getFeed>[1]) =>
    ids((await getFeed(db, { now: NOW, ...filters })).items);

  it('filters by platform, source, state, score, label, freshness, rights, flags', async () => {
    expect(await only({ filters: { platform: 'twitch' } })).toEqual([seeded.provisional.clusterId]);
    expect((await only({ filters: { source: 'bluesky' } })).sort()).toEqual(
      [seeded.breakout.clusterId, seeded.insufficient.clusterId].sort(),
    );
    expect(await only({ filters: { state: 'insufficient_evidence' } })).toEqual([
      seeded.insufficient.clusterId,
    ]);
    expect(await only({ filters: { state: 'unscored' } })).toEqual([seeded.unscored.clusterId]);
    expect(await only({ filters: { minScore: 70 } })).toEqual([seeded.breakout.clusterId]);
    expect(await only({ filters: { label: 'animals' } })).toEqual([seeded.breakout.clusterId]);
    expect(await only({ filters: { label: 'gaming' } })).toEqual([]);
    expect((await only({ filters: { discoveredWithinHours: 2 } })).sort()).toEqual(
      [seeded.provisional.clusterId, seeded.unscored.clusterId].sort(),
    );
    expect((await only({ filters: { rights: 'unknown' } })).length).toBe(5);
    expect(await only({ filters: { flagged: true } })).toEqual([]);
  });

  it('filters by review status, including unreviewed', async () => {
    await recordReview(db, { clusterId: seeded.breakout.clusterId, status: 'saved', now: NOW });
    await recordReview(db, { clusterId: seeded.lower.clusterId, status: 'rejected', now: NOW });
    expect(await only({ filters: { review: 'saved' } })).toEqual([seeded.breakout.clusterId]);
    expect(await only({ filters: { review: 'rejected' } })).toEqual([seeded.lower.clusterId]);
    expect(await only({ filters: { review: 'unreviewed' } })).toEqual([
      seeded.provisional.clusterId,
      seeded.insufficient.clusterId,
      seeded.unscored.clusterId,
    ]);
  });
});

describe('card view model', () => {
  it('separates public propagation from manual provenance', async () => {
    const { items } = await getFeed(db, { now: NOW });
    const card = toCardView(items[0]!, ROLES, NOW);
    expect(card.platform).toBe('YouTube');
    expect(card.publicPropagation.map((s) => [s.source, s.observations])).toEqual([
      ['bluesky', 2],
      ['youtube', 1],
    ]);
    expect(card.provenance.map((s) => [s.source, s.observations])).toEqual([['manual-url', 1]]);
    expect(card.score).toMatchObject({ state: 'scored', stateLabel: 'SCORED', confidence: 'High' });
    expect(card.components.find((c) => c.key === 'creatorOutlier')).toMatchObject({
      available: false,
      strength: 'unavailable',
    });
    expect(card.classification).toMatchObject({ kind: 'classified' });
    expect(card.metrics).toMatchObject({ views: '190k', likes: '15.5k', comments: '910' });
  });

  it('shows unclassified, failed classification, missing thumbnail, and missing metrics honestly', async () => {
    const { items } = await getFeed(db, { now: NOW });
    const twitch = toCardView(
      items.find((i) => i.clusterId === seeded.provisional.clusterId)!,
      ROLES,
      NOW,
    );
    expect(twitch).toMatchObject({ thumbnailUrl: null, classification: { kind: 'unclassified' } });
    expect(twitch.components.find((c) => c.key === 'engagement')?.reason).toMatch(
      /no view count|no likes/,
    );
    const tiktok = toCardView(
      items.find((i) => i.clusterId === seeded.insufficient.clusterId)!,
      ROLES,
      NOW,
    );
    expect(tiktok).toMatchObject({ metrics: null, ageBasis: 'discovered' });

    await db.insert(schema.classificationFailures).values({
      clusterId: seeded.provisional.clusterId,
      provider: 'fake',
      model: 'm',
      taxonomyVersion: TAXONOMY_VERSION,
      promptVersion: PROMPT_VERSION,
      inputHash: 'x',
      errorKind: 'invalid_output',
      error: 'bad',
      attemptedAt: NOW,
    });
    const after = (await getFeed(db, { now: NOW })).items.find(
      (i) => i.clusterId === seeded.provisional.clusterId,
    )!;
    expect(toCardView(after, ROLES, NOW).classification).toEqual({
      kind: 'failed',
      error: 'invalid_output',
    });
  });

  it('formats counts compactly without trailing zeros', () => {
    expect([
      formatCount(910),
      formatCount(12_000),
      formatCount(15_500),
      formatCount(190_000),
      formatCount(null),
    ]).toEqual(['910', '12k', '15.5k', '190k', '—']);
  });

  it('treats sources from unknown adapters as provenance', async () => {
    const { items } = await getFeed(db, { now: NOW });
    const card = toCardView(items[0]!, { youtube: 'propagation' }, NOW);
    expect(card.publicPropagation.map((s) => s.source)).toEqual(['youtube']);
  });
});

describe('review actions (append-only, cluster-level)', () => {
  it('records all four statuses; latest wins; history is kept', async () => {
    const id = seeded.breakout.clusterId;
    for (const [i, status] of (
      ['saved', 'approved', 'already_used', 'rejected'] as const
    ).entries()) {
      const r = await recordReview(db, {
        clusterId: id,
        status,
        now: new Date(NOW.getTime() + i * 1000),
      });
      expect(r.created).toBe(true);
    }
    const events = await db
      .select()
      .from(schema.reviewEvents)
      .where(eq(schema.reviewEvents.clusterId, id));
    expect(events.map((e) => e.status).sort()).toEqual([
      'already_used',
      'approved',
      'rejected',
      'saved',
    ]);
    expect(
      (await getFeed(db, { now: NOW })).items.find((i) => i.clusterId === id)!.reviewStatus,
    ).toBe('rejected');
  });

  it('is idempotent for a repeated decision and validates input', async () => {
    const id = seeded.breakout.clusterId;
    const a = await recordReview(db, {
      clusterId: id,
      status: 'approved',
      note: ' good one ',
      now: NOW,
    });
    const b = await recordReview(db, {
      clusterId: id,
      status: 'approved',
      note: 'good one',
      now: NOW,
    });
    expect(b).toMatchObject({ created: false });
    expect(b.event.id).toBe(a.event.id);
    await expect(recordReview(db, { clusterId: id, status: 'published' })).rejects.toBeInstanceOf(
      ReviewError,
    );
    await expect(
      recordReview(db, { clusterId: '00000000-0000-0000-0000-000000000000', status: 'saved' }),
    ).rejects.toThrow(/not found/);
    await expect(
      recordReview(db, { clusterId: id, status: 'saved', note: 'x'.repeat(501) }),
    ).rejects.toThrow(/500/);
  });

  it('one decision covers every version in the cluster; the feed shows one card', async () => {
    const repost = await seedCandidate(db, {
      platform: 'youtube',
      platformVideoId: 'vdRepost01',
      title: 'Cat discovers the vacuum cleaner (reupload)',
      firstDiscoveredAt: hoursAgo(2),
      sightings: [{ source: 'youtube', key: 'mostPopular:GB:all', at: hoursAgo(2) }],
      score: false,
    });
    // Join the repost to the original's cluster (as near-duplicate detection eventually will).
    await db
      .update(schema.videos)
      .set({ clusterId: seeded.breakout.clusterId })
      .where(eq(schema.videos.id, repost.videoId));
    await db.delete(schema.clusters).where(eq(schema.clusters.id, repost.clusterId));

    await recordReview(db, { clusterId: seeded.breakout.clusterId, status: 'approved', now: NOW });
    const { items } = await getFeed(db, { now: NOW });
    const card = items.filter((i) => i.title?.startsWith('Cat discovers'));
    expect(card).toHaveLength(1);
    expect(card[0]).toMatchObject({
      versions: 2,
      reviewStatus: 'approved',
      platformVideoId: 'vdFixture01',
    });
    const detail = await getCandidate(db, seeded.breakout.clusterId);
    expect(detail!.versions.map((v) => [v.platformVideoId, v.isRepresentative])).toEqual([
      ['vdFixture01', true],
      ['vdRepost01', false],
    ]);
  });
});

describe('rights (separate from review)', () => {
  it('keeps history, is idempotent, and is independent of approval', async () => {
    const id = seeded.breakout.clusterId;
    await recordReview(db, { clusterId: id, status: 'approved', now: NOW });
    let row = (await getFeed(db, { now: NOW })).items[0]!;
    expect([row.reviewStatus, row.rightsStatus]).toEqual(['approved', 'unknown']);

    await setRights(db, { clusterId: id, status: 'requested', notes: 'DM sent', now: NOW });
    expect(
      (await setRights(db, { clusterId: id, status: 'requested', notes: 'DM sent', now: NOW }))
        .created,
    ).toBe(false);
    await setRights(db, {
      clusterId: id,
      status: 'granted',
      rightsHolder: 'Fixture Pets',
      evidenceUrl: 'https://example.test/permission',
      now: new Date(NOW.getTime() + 1000),
    });
    row = (await getFeed(db, { now: NOW })).items[0]!;
    expect(row.rightsStatus).toBe('granted');
    const detail = await getCandidate(db, id);
    expect(detail!.rights.map((r) => r.status)).toEqual(['granted', 'requested']);
    await expect(setRights(db, { clusterId: id, status: 'cleared' })).rejects.toBeInstanceOf(
      ReviewError,
    );
    await expect(
      setRights(db, { clusterId: id, status: 'granted', evidenceUrl: 'javascript:alert(1)' }),
    ).rejects.toThrow(/http/);
  });
});

describe('detail', () => {
  it('returns metrics history, score history, classification, sightings, and review history', async () => {
    await recordReview(db, {
      clusterId: seeded.breakout.clusterId,
      status: 'saved',
      note: 'check rights',
      now: NOW,
    });
    const d = (await getCandidate(db, seeded.breakout.clusterId))!;
    expect(d.snapshots.map((s) => s.views)).toEqual([12_000, 48_000, 190_000]);
    expect(growthSeries(d.snapshots)).toMatchObject({ metric: 'views' });
    expect(d.scores).toHaveLength(1);
    expect(d.scores[0]).toMatchObject({ algorithmVersion: 'breakout-v1.1', state: 'scored' });
    expect(d.classifications[0]).toMatchObject({
      current: true,
      provider: 'fake',
      summary: 'A cat encounters a robot vacuum and ends up riding it.',
      analysis: { whyItMayWork: expect.stringMatching(/Immediate visual hook/) as unknown },
    });
    expect(d.sightings.map((s) => s.source).sort()).toEqual([
      'bluesky',
      'bluesky',
      'manual-url',
      'youtube',
    ]);
    expect(d.reviews).toEqual([
      expect.objectContaining({ status: 'saved', note: 'check rights', reviewer: 'owner' }),
    ]);
    expect(await getCandidate(db, 'not-a-uuid')).toBeNull();
    expect(await getCandidate(db, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});

describe('summary', () => {
  it('counts the review workflow buckets', async () => {
    await recordReview(db, { clusterId: seeded.breakout.clusterId, status: 'saved', now: NOW });
    expect(await getSummary(db)).toMatchObject({
      total: 5,
      breakingOut: 1,
      unreviewed: 4,
      saved: 1,
      approved: 0,
      insufficientEvidence: 1,
      unclassified: 4,
    });
  });
});
