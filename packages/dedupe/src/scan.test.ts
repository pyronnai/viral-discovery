import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema, type AnyDatabase } from '@vd/db';
import {
  DuplicateError,
  chooseRepresentative,
  confirmDuplicate,
  rejectDuplicate,
  resolveCluster,
} from './merge.ts';
import { excludeDuplicatesOfSelected } from './planner.ts';
import { explainPair, scanDuplicates } from './scan.ts';
import { clusterDecisionState, mergeConflicts, type ClusterDecisionState } from './state.ts';
import {
  NOW,
  boxed,
  createTestDb,
  fakeHasher,
  hoursAgo,
  seedVideo,
  syntheticImage,
  toJpeg,
  watermarked,
} from './testing.ts';

let db: AnyDatabase;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});

const URLS = {
  ytCat: 'https://i.ytimg.com/vi/ytCat/hqdefault.jpg',
  twitchCat: 'https://static-cdn.jtvnw.net/twitch-clip-thumbnails/cat.jpg',
  ttCat: 'https://p16-sign.tiktokcdn-us.com/cat.jpeg',
  twitchOverlayA: 'https://static-cdn.jtvnw.net/twitch-clip-thumbnails/overlay-a.jpg',
  twitchOverlayB: 'https://static-cdn.jtvnw.net/twitch-clip-thumbnails/overlay-b.jpg',
  ttTreat1: 'https://p16-sign.tiktokcdn-us.com/treat1.jpeg',
  ttTreat2: 'https://p16-sign.tiktokcdn-us.com/treat2.jpeg',
};
const cat = syntheticImage(7);
const overlay = syntheticImage(21);
const images = {
  // A: the same clip — YouTube Shorts thumbnail is pillar-boxed, Twitch re-encoded.
  [URLS.ytCat]: toJpeg(boxed(cat, 480, 360)),
  [URLS.twitchCat]: toJpeg(cat, 70),
  // B: TikTok repost with a watermark.
  [URLS.ttCat]: toJpeg(watermarked(cat), 80),
  // C: same stream overlay, different clips.
  [URLS.twitchOverlayA]: toJpeg(overlay),
  [URLS.twitchOverlayB]: toJpeg(watermarked(overlay)),
  // D: same trend, different videos.
  [URLS.ttTreat1]: toJpeg(syntheticImage(31)),
  [URLS.ttTreat2]: toJpeg(syntheticImage(32)),
};

async function seedWorkedExamples() {
  const yt = await seedVideo(db, {
    platform: 'youtube',
    platformVideoId: 'ytCat',
    title: 'Cat discovers the vacuum cleaner',
    durationMs: 42_000,
    publishedAt: hoursAgo(30),
    firstDiscoveredAt: hoursAgo(20),
    creator: 'Fixture Pets',
    thumbnailUrl: URLS.ytCat,
    views: [12_000, 190_000],
  });
  const twitch = await seedVideo(db, {
    platform: 'twitch',
    platformVideoId: 'CatClip-xyz',
    title: 'cat discovers vacuum cleaner LOL',
    durationMs: 42_400,
    publishedAt: hoursAgo(28),
    firstDiscoveredAt: hoursAgo(10),
    creator: 'FixturePets',
    thumbnailUrl: URLS.twitchCat,
    views: [900],
  });
  const tiktok = await seedVideo(db, {
    platform: 'tiktok',
    platformVideoId: '7400000000000000001',
    title: 'this cat discovered the vacuum cleaner 😭 #cat #funny #fyp',
    firstDiscoveredAt: hoursAgo(5),
    creator: 'repost.daily',
    thumbnailUrl: URLS.ttCat,
    sightings: [
      { source: 'bluesky', key: 'at://post/1', postUrl: 'https://bsky.app/profile/x/post/1' },
    ],
  });
  const overlayA = await seedVideo(db, {
    platform: 'twitch',
    platformVideoId: 'OverlayClip-a',
    title: 'chat made me do it',
    durationMs: 28_000,
    publishedAt: hoursAgo(3),
    firstDiscoveredAt: hoursAgo(2),
    creator: 'FixtureStreamer',
    thumbnailUrl: URLS.twitchOverlayA,
  });
  const overlayB = await seedVideo(db, {
    platform: 'youtube',
    platformVideoId: 'OverlayVod-b',
    title: 'FixtureStreamer full highlight: chat made me do it again',
    durationMs: 190_000,
    publishedAt: hoursAgo(2),
    firstDiscoveredAt: hoursAgo(1),
    creator: 'FixtureStreamer',
    thumbnailUrl: URLS.twitchOverlayB,
  });
  const treat1 = await seedVideo(db, {
    platform: 'tiktok',
    platformVideoId: '7400000000000000002',
    title: 'when the cat hears the treat bag #funny #cat',
    firstDiscoveredAt: hoursAgo(6),
    creator: 'Fixture Creator',
    thumbnailUrl: URLS.ttTreat1,
  });
  const treat2 = await seedVideo(db, {
    platform: 'tiktok',
    platformVideoId: '7400000000000000003',
    title: 'my cat when she hears the treat bag 😂 #cat #fyp',
    firstDiscoveredAt: hoursAgo(4),
    creator: 'another.creator',
    thumbnailUrl: URLS.ttTreat2,
  });
  return { yt, twitch, tiktok, overlayA, overlayB, treat1, treat2 };
}

const candidates = () => db.select().from(schema.duplicateCandidates);
const clusterOf = async (videoId: string) =>
  (await db.select().from(schema.videos).where(eq(schema.videos.id, videoId)))[0]!.clusterId!;

describe('scanDuplicates (worked examples)', () => {
  it('auto-confirms A, suggests B, rejects C and D', async () => {
    const s = await seedWorkedExamples();
    const hasher = fakeHasher(images);
    const summary = await scanDuplicates(db, { hasher, now: NOW });
    expect(summary.errors).toEqual([]);
    expect(summary.thumbnails.hashed).toBe(7);

    // A: YouTube + Twitch → one cluster.
    expect(await clusterOf(s.twitch.videoId)).toBe(await clusterOf(s.yt.videoId));
    expect(summary.autoConfirmed).toBe(1);

    // B: TikTok repost (no duration) → possible only; separate cluster, nothing shared.
    const rows = await candidates();
    const withTikTok = rows.filter((r) => [r.videoAId, r.videoBId].includes(s.tiktok.videoId));
    expect(withTikTok.length).toBeGreaterThanOrEqual(1);
    expect(withTikTok.every((r) => r.status === 'possible')).toBe(true);
    expect(withTikTok[0]!.reasons).toContain('AUTO_BLOCKED_NO_DURATION');
    expect(await clusterOf(s.tiktok.videoId)).not.toBe(await clusterOf(s.yt.videoId));

    // C: visually similar thumbnails, very different duration → no suggestion.
    const pairIds = rows.map((r) => [r.videoAId, r.videoBId].sort().join());
    expect(pairIds).not.toContain([s.overlayA.videoId, s.overlayB.videoId].sort().join());
    const c = await explainPair(db, s.overlayA.videoId, s.overlayB.videoId);
    expect(c?.evidence.thumbnail.grade).toMatch(/identical|very_close/);
    expect(c?.vetoes).toEqual(['DURATION_MISMATCH']);

    // D: same trend, different videos → no suggestion.
    expect(pairIds).not.toContain([s.treat1.videoId, s.treat2.videoId].sort().join());
    const d = await explainPair(db, s.treat1.videoId, s.treat2.videoId);
    expect(d?.evidence.title.grade).toBe('strong');
    expect(d?.evidence.thumbnail.grade).toBe('different');
    expect(d?.decision).toBe('no_match');
  });

  it('stores hashes once per URL and keeps going when a thumbnail cannot be fetched', async () => {
    const s = await seedWorkedExamples();
    const hasher = fakeHasher({
      ...images,
      [URLS.twitchCat]: { status: 'host_not_allowed', hash: null, reason: 'x' },
    });
    const first = await scanDuplicates(db, { hasher, now: NOW, autoConfirm: false });
    expect(first.errors).toEqual([]);
    const [tw] = await db
      .select()
      .from(schema.videos)
      .where(eq(schema.videos.id, s.twitch.videoId));
    expect(tw).toMatchObject({
      thumbnailPhash: null,
      thumbnailHashStatus: 'host_not_allowed',
      thumbnailHashUrl: URLS.twitchCat,
    });
    // Without the thumbnail, YouTube↔Twitch still matches on duration + title + creator.
    const yt = (await candidates()).find(
      (r) =>
        [r.videoAId, r.videoBId].includes(s.yt.videoId) &&
        [r.videoAId, r.videoBId].includes(s.twitch.videoId),
    );
    expect(yt).toMatchObject({ status: 'possible' });
    expect(yt!.reasons).toContain('AUTO_BLOCKED_NO_THUMBNAIL_HASH');

    const calls = hasher.calls.length;
    await scanDuplicates(db, { hasher, now: NOW, scope: { sinceHours: 48 } });
    expect(hasher.calls.length).toBe(calls); // nothing refetched: every URL has a remembered outcome
  });

  it('never pairs a video with itself; exact identity stays a hard uniqueness rule', async () => {
    const s = await seedWorkedExamples();
    await expect(
      db
        .insert(schema.videos)
        .values({ platform: 'youtube', platformVideoId: 'ytCat', canonicalUrl: 'https://x.test' }),
    ).rejects.toThrow();
    await scanDuplicates(db, { hasher: fakeHasher(images), now: NOW });
    for (const r of await candidates()) expect(r.videoAId).not.toBe(r.videoBId);
    expect(
      (await candidates()).some((r) => r.videoAId === s.yt.videoId && r.videoBId === s.yt.videoId),
    ).toBe(false);
  });

  it('does not auto-merge when both sides already carry human decisions', async () => {
    const s = await seedWorkedExamples();
    await db.insert(schema.reviewEvents).values([
      { clusterId: s.yt.clusterId, status: 'approved', createdAt: hoursAgo(2) },
      { clusterId: s.twitch.clusterId, status: 'saved', createdAt: hoursAgo(2) },
    ]);
    await scanDuplicates(db, { hasher: fakeHasher(images), now: NOW });
    expect(await clusterOf(s.twitch.videoId)).not.toBe(await clusterOf(s.yt.videoId));
    const pair = (await candidates()).find(
      (r) =>
        [r.videoAId, r.videoBId].includes(s.twitch.videoId) &&
        [r.videoAId, r.videoBId].includes(s.yt.videoId),
    );
    expect(pair?.reasons).toContain('AUTO_BLOCKED_BOTH_SIDES_REVIEWED');
  });
});

describe('human decisions and cluster merges', () => {
  async function possibleTikTokPair() {
    const s = await seedWorkedExamples();
    await scanDuplicates(db, { hasher: fakeHasher(images), now: hoursAgo(1) });
    const pair = (await candidates()).find(
      (r) => r.status === 'possible' && [r.videoAId, r.videoBId].includes(s.tiktok.videoId),
    )!;
    return { s, pair };
  }

  it('confirm merges clusters and preserves videos, sightings, snapshots, scores and classifications', async () => {
    const { s, pair } = await possibleTikTokPair();
    const survivor = await clusterOf(s.yt.videoId);
    await db.insert(schema.scores).values({
      videoId: s.tiktok.videoId,
      algorithmVersion: 'breakout-v1.1',
      value: null,
      state: 'insufficient_evidence',
      computedAt: hoursAgo(1),
    });
    await db.insert(schema.classifications).values({
      clusterId: s.tiktok.clusterId,
      videoId: s.tiktok.videoId,
      taxonomyVersion: 't',
      promptVersion: 'p',
      model: 'm',
      labels: [{ label: 'animals', confidence: 0.9 }],
    });
    const before = {
      sightings: (await db.select().from(schema.sightings)).length,
      snapshots: (await db.select().from(schema.metricSnapshots)).length,
      scores: (await db.select().from(schema.scores)).length,
      videos: (await db.select().from(schema.videos)).length,
    };
    const r = await confirmDuplicate(db, pair.id, { now: NOW, note: 'same clip, reposted' });
    expect(r.merge?.survivorClusterId).toBe(survivor);
    expect(await clusterOf(s.tiktok.videoId)).toBe(survivor);
    expect({
      sightings: (await db.select().from(schema.sightings)).length,
      snapshots: (await db.select().from(schema.metricSnapshots)).length,
      scores: (await db.select().from(schema.scores)).length,
      videos: (await db.select().from(schema.videos)).length,
    }).toEqual(before);
    const cls = await db
      .select()
      .from(schema.classifications)
      .where(eq(schema.classifications.clusterId, survivor));
    expect(cls.map((c) => c.videoId)).toContain(s.tiktok.videoId);
    const [absorbed] = await db
      .select()
      .from(schema.clusters)
      .where(eq(schema.clusters.id, s.tiktok.clusterId));
    expect(absorbed).toMatchObject({ mergedIntoClusterId: survivor, representativeVideoId: null });
    expect(await resolveCluster(db, s.tiktok.clusterId)).toBe(survivor);
    const [c] = await db
      .select()
      .from(schema.duplicateCandidates)
      .where(eq(schema.duplicateCandidates.id, pair.id));
    expect(c).toMatchObject({
      status: 'confirmed',
      decidedBy: 'owner',
      note: 'same clip, reposted',
    });
    // The TikTok↔Twitch suggestion became moot (all three share the cluster) and was settled.
    const open = (await candidates()).filter((x) => x.status === 'possible');
    expect(open.some((x) => [x.videoAId, x.videoBId].includes(s.tiktok.videoId))).toBe(false);
    // Representative: the YouTube upload (available, canonical metrics, richest metadata).
    const [cluster] = await db
      .select()
      .from(schema.clusters)
      .where(eq(schema.clusters.id, survivor));
    expect(cluster!.representativeVideoId).toBe(s.yt.videoId);
  });

  it('reject is remembered and never resurfaced by later scans', async () => {
    const { s, pair } = await possibleTikTokPair();
    await rejectDuplicate(db, pair.id, { now: NOW });
    await db.update(schema.videos).set({ duplicateScannedAt: null });
    const again = await scanDuplicates(db, { hasher: fakeHasher(images), now: NOW });
    const after = (await candidates()).filter((r) =>
      [r.videoAId, r.videoBId].includes(s.tiktok.videoId),
    );
    expect(after.every((r) => r.status === 'rejected')).toBe(true);
    expect(
      again.pairs
        .filter((p) => p.otherVideoId === s.tiktok.videoId || p.targetVideoId === s.tiktok.videoId)
        .map((p) => p.action),
    ).not.toContain('suggested');
    await expect(
      rejectDuplicate(db, (await candidates()).find((r) => r.status === 'auto_confirmed')!.id),
    ).rejects.toThrow(DuplicateError);
  });

  it('surfaces a review conflict instead of silently picking a decision', async () => {
    const { s, pair } = await possibleTikTokPair();
    const ytCluster = await clusterOf(s.yt.videoId);
    await db.insert(schema.reviewEvents).values([
      { clusterId: ytCluster, status: 'approved', createdAt: hoursAgo(0.5) },
      {
        clusterId: s.tiktok.clusterId,
        status: 'rejected',
        note: 'repost account',
        createdAt: hoursAgo(0.4),
      },
    ]);
    const r = await confirmDuplicate(db, pair.id, { now: NOW });
    expect(r.merge).toMatchObject({ reviewConflict: true, rightsConflict: false });
    const state = await clusterDecisionState(db, ytCluster);
    expect(state).toMatchObject({ reviewConflict: true, review: 'rejected' });
    const events = await db
      .select()
      .from(schema.reviewEvents)
      .where(eq(schema.reviewEvents.clusterId, ytCluster));
    expect(events.map((e) => e.status).sort()).toEqual(['approved', 'rejected']);
    expect(events.find((e) => e.status === 'rejected')!.originClusterId).toBe(s.tiktok.clusterId);
    // A new decision after the merge resolves it.
    await db.insert(schema.reviewEvents).values({
      clusterId: ytCluster,
      status: 'approved',
      createdAt: new Date(NOW.getTime() + 60_000),
    });
    expect((await clusterDecisionState(db, ytCluster)).reviewConflict).toBe(false);
  });

  it('never widens rights: a grant for one representation becomes a rights conflict', async () => {
    const { s, pair } = await possibleTikTokPair();
    const ytCluster = await clusterOf(s.yt.videoId);
    await db.insert(schema.rights).values({
      clusterId: s.tiktok.clusterId,
      status: 'granted',
      rightsHolder: 'repost.daily',
      createdAt: hoursAgo(0.5),
    });
    const r = await confirmDuplicate(db, pair.id, { now: NOW });
    expect(r.merge?.rightsConflict).toBe(true);
    expect(await clusterDecisionState(db, ytCluster)).toMatchObject({
      rightsConflict: true,
      rights: 'granted',
    });
    const [merge] = await db
      .select()
      .from(schema.clusterMerges)
      .where(eq(schema.clusterMerges.rightsConflict, true));
    expect(merge!.details['rightsReason']).toMatch(/one representation only/);
  });

  it('refuses to confirm when another version pair was already rejected', async () => {
    const { s, pair } = await possibleTikTokPair();
    const [video] = await db
      .insert(schema.videos)
      .values({
        platform: 'tiktok',
        platformVideoId: '7400000000000000009',
        canonicalUrl: 'https://x.test/9',
        clusterId: await clusterOf(s.tiktok.videoId),
      })
      .returning();
    const [a, b] = [video!.id, s.yt.videoId].sort() as [string, string];
    await db.insert(schema.duplicateCandidates).values({
      videoAId: a,
      videoBId: b,
      status: 'rejected',
      confidence: 0.5,
      detectorVersion: 'x',
    });
    await expect(confirmDuplicate(db, pair.id, { now: NOW })).rejects.toThrow(/not the same/);
  });
});

describe('merge conflict rules', () => {
  const state = (over: Partial<ClusterDecisionState>): ClusterDecisionState => ({
    review: null,
    reviewAt: null,
    reviewConflict: false,
    rights: null,
    rightsHolder: null,
    rightsAt: null,
    rightsConflict: false,
    hasHumanDecisions: false,
    ...over,
  });
  it.each([
    [{ review: 'approved' }, { review: 'approved' }, false],
    [{ review: 'approved' }, {}, false],
    [{ review: 'approved' }, { review: 'rejected' }, true],
    [{ review: 'saved' }, { review: 'approved' }, true],
    [{ reviewConflict: true }, {}, true],
  ])('review %j + %j → conflict %s', (a, b, conflict) => {
    expect(mergeConflicts(state(a), state(b)).review).toBe(conflict);
  });
  it.each([
    [{ rights: 'requested' }, {}, false],
    [{ rights: 'denied' }, {}, false],
    [{ rights: 'granted', rightsHolder: 'Ann' }, {}, true],
    [
      { rights: 'granted', rightsHolder: 'Ann' },
      { rights: 'granted', rightsHolder: 'ann ' },
      false,
    ],
    [{ rights: 'granted', rightsHolder: 'Ann' }, { rights: 'granted', rightsHolder: 'Bob' }, true],
    [{ rights: 'granted' }, { rights: 'granted' }, true],
    [{ rights: 'requested' }, { rights: 'denied' }, true],
    [{ rights: 'own_content' }, { rights: 'unknown' }, true],
  ])('rights %j + %j → conflict %s', (a, b, conflict) => {
    expect(mergeConflicts(state(a), state(b)).rights).toBe(conflict);
  });
});

describe('representative selection', () => {
  const base = {
    availability: 'available',
    hasMetrics: true,
    thumbnailUrl: 'https://i.ytimg.com/x.jpg',
    title: 't',
    durationMs: 1,
    publishedAt: new Date('2026-09-01T00:00:00Z'),
    hasCreator: true,
    firstDiscoveredAt: new Date('2026-09-02T00:00:00Z'),
  };
  it('prefers available → canonical metrics → thumbnail → metadata → earliest publish; never popularity', () => {
    expect(
      chooseRepresentative([
        { ...base, id: 'b', availability: 'removed' },
        { ...base, id: 'c', hasMetrics: false },
      ]).id,
    ).toBe('c');
    expect(
      chooseRepresentative([
        { ...base, id: 'b', hasMetrics: false },
        { ...base, id: 'c' },
      ]).id,
    ).toBe('c');
    expect(
      chooseRepresentative([
        { ...base, id: 'b', thumbnailUrl: null },
        { ...base, id: 'c', durationMs: null },
      ]).id,
    ).toBe('c');
    expect(
      chooseRepresentative([
        { ...base, id: 'b', durationMs: null },
        { ...base, id: 'c' },
      ]).id,
    ).toBe('c');
    expect(
      chooseRepresentative([
        { ...base, id: 'b' },
        { ...base, id: 'c', publishedAt: new Date('2026-08-01T00:00:00Z') },
      ]).id,
    ).toBe('c');
    expect(
      chooseRepresentative([
        { ...base, id: 'b' },
        { ...base, id: 'a' },
      ]).id,
    ).toBe('a');
  });
});

describe('planner-facing duplicate exclusion', () => {
  it('excludes confirmed and high-confidence possible duplicates of selected content, not rejected ones', async () => {
    const s = await seedWorkedExamples();
    await scanDuplicates(db, { hasher: fakeHasher(images), now: NOW });
    const ytCluster = await clusterOf(s.yt.videoId);
    const all = [s.yt, s.twitch, s.tiktok, s.overlayA, s.overlayB, s.treat1, s.treat2].map(
      (x) => x.clusterId,
    );

    const r = await excludeDuplicatesOfSelected(db, {
      selectedVideoIds: [s.yt.videoId],
      candidateClusterIds: all,
    });
    expect(r.excluded).toEqual(
      expect.arrayContaining([
        { clusterId: ytCluster, reason: 'selected', ofClusterId: ytCluster, confidence: null },
        expect.objectContaining({
          clusterId: s.tiktok.clusterId,
          reason: 'possible_duplicate',
          ofClusterId: ytCluster,
        }),
      ]),
    );
    // Twitch was auto-merged into the YouTube cluster: excluded as the same content, and counted once.
    expect(r.kept).toEqual([
      s.overlayA.clusterId,
      s.overlayB.clusterId,
      s.treat1.clusterId,
      s.treat2.clusterId,
    ]);

    const pair = (await candidates()).find(
      (c) => c.status === 'possible' && [c.videoAId, c.videoBId].includes(s.tiktok.videoId),
    )!;
    await rejectDuplicate(db, pair.id, { now: NOW });
    const afterReject = await excludeDuplicatesOfSelected(db, {
      selectedClusterIds: [ytCluster],
      candidateClusterIds: all,
    });
    expect(afterReject.kept).toContain(s.tiktok.clusterId);
  });
});

describe('bounded candidate generation', () => {
  it('compares each target against at most three LIMITed blocks, never all videos', async () => {
    const n = 400;
    const values = Array.from({ length: n }, (_, i) => ({
      platform: 'youtube',
      platformVideoId: `bulk${i}`,
      canonicalUrl: `https://example.test/bulk${i}`,
      title: `bulk cat video number ${i} ${i % 7 === 0 ? 'vacuum' : 'garden'}`,
      durationMs: 30_000 + (i % 40) * 500,
      firstDiscoveredAt: hoursAgo(i % 100),
      thumbnailPhash: i.toString(16).padStart(16, '0'),
      thumbnailHashBands: [`0:00`, `7:${(i % 256).toString(16).padStart(2, '0')}`],
    }));
    const videos = await db
      .insert(schema.videos)
      .values(values)
      .returning({ id: schema.videos.id });
    const clusters = await db
      .insert(schema.clusters)
      .values(videos.map((v) => ({ representativeVideoId: v.id })))
      .returning({ id: schema.clusters.id, rep: schema.clusters.representativeVideoId });
    await db.execute(
      sql`update videos v set cluster_id = c.id from clusters c where c.representative_video_id = v.id`,
    );
    expect(clusters).toHaveLength(n);

    const target = await seedVideo(db, {
      platform: 'twitch',
      platformVideoId: 'target',
      title: 'cat vacuum',
      durationMs: 35_000,
      firstDiscoveredAt: hoursAgo(1),
      thumbnailUrl: URLS.twitchCat,
    });
    const perBlock = 15;
    const summary = await scanDuplicates(db, {
      scope: { videoIds: [target.videoId] },
      hasher: fakeHasher({
        [URLS.twitchCat]: { status: 'hashed', hash: '0000000000000001', reason: null },
      }),
      perBlock,
      now: NOW,
      autoConfirm: false,
    });
    expect(summary.targets).toBe(1);
    expect(summary.candidatesGenerated).toBeLessThanOrEqual(3 * perBlock);
    expect(summary.comparisons).toBe(summary.candidatesGenerated);
    expect(summary.comparisons).toBeLessThan(n / 5);
  });
});
