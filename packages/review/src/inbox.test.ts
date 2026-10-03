import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq as sqlEq } from 'drizzle-orm';
import { schema, type AnyDatabase } from '@vd/db';
import { confirmDuplicate } from '@vd/dedupe';
import { ReviewError, bulkApply, recordAcquisition, recordReview, setSaved } from './actions.ts';
import { getCreatorHistory } from './detail.ts';
import { csvCell, getExportRows, toCsv, toJson } from './export.ts';
import { VIRAL_NOW_HOURS, getFeed, getSummary, type FeedFilters, type FeedSort } from './feed.ts';
import { getDiscoveryHealth } from './health.ts';
import { toCardView } from './present.ts';
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

const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const ids = async (filters: FeedFilters, sort?: FeedSort) =>
  (await getFeed(db, { now: NOW, filters, pageSize: 100, ...(sort ? { sort } : {}) })).items.map(
    (i) => i.clusterId,
  );
const card = async (clusterId: string) => {
  const row = (await getFeed(db, { now: NOW, pageSize: 100 })).items.find(
    (i) => i.clusterId === clusterId,
  );
  return toCardView(row!, ROLES, NOW);
};

/** A TikTok repost of the breakout, confirmed as the same clip. */
async function confirmedRepost() {
  const repost = await seedCandidate(db, {
    platform: 'tiktok',
    platformVideoId: '7411111111111111111',
    title: 'cat vs vacuum 😭',
    firstDiscoveredAt: hoursAgo(2),
    creator: 'repost.daily',
    sightings: [{ source: 'manual-url', key: 'tiktok:7411111111111111111', at: hoursAgo(2) }],
  });
  const [a, b] = [seeded.breakout.videoId, repost.videoId].sort() as [string, string];
  const [pair] = await db
    .insert(schema.duplicateCandidates)
    .values({ videoAId: a, videoBId: b, confidence: 0.7, detectorVersion: 'near-dup-v1' })
    .returning();
  return { repost, pairId: pair!.id };
}

describe('source moderation (platform labels, not AI)', () => {
  const MOD = 'did:plc:ar7c4by46qjdydhdevvrndac';
  const label = (value: string, explicit: boolean, selfApplied = false) => ({
    value,
    labeler: MOD,
    scope: 'content' as const,
    selfApplied,
    explicit,
  });
  const setLabels = (videoId: string, labels: ReturnType<typeof label>[]) =>
    db
      .update(schema.videos)
      .set({ sourceModerationLabels: labels })
      .where(sqlEq(schema.videos.id, videoId));

  it('keeps explicitly labelled content out of Viral Now but visible in All and Flagged', async () => {
    await setLabels(seeded.breakout.videoId, [label('porn', true)]);
    await setLabels(seeded.provisional.videoId, [label('!warn', false)]);

    const viral = await ids({ view: 'viral' });
    expect(viral).not.toContain(seeded.breakout.clusterId);
    // A non-explicit platform label (e.g. "!warn") is not treated as adult content.
    expect(viral).toContain(seeded.provisional.clusterId);
    expect(await ids({ view: 'all' })).toContain(seeded.breakout.clusterId);
    expect(await ids({ view: 'all', flagged: true })).toEqual([seeded.breakout.clusterId]);

    const summary = await getSummary(db, NOW);
    expect(summary.viralNow).toBe(1);
    expect(summary.flagged).toBe(1);

    const view = await card(seeded.breakout.clusterId);
    expect(view.sourceModeration.explicit).toBe(true);
    expect(view.sourceModeration.labels).toEqual([
      expect.objectContaining({ value: 'porn', explicit: true, by: 'YouTube moderation' }),
    ]);
    // Platform labels are separate from (and independent of) AI classification.
    expect(view.classification.kind).not.toBe('failed');
    const [row] = await getExportRows(db, { clusterIds: [seeded.breakout.clusterId] });
    expect(row?.platformLabels).toEqual(['youtube:porn']);
  });

  it('treats no reported labels (NULL) and an empty label set alike: nothing hidden', async () => {
    const before = await ids({ view: 'viral' });
    await setLabels(seeded.breakout.videoId, []);
    expect(await ids({ view: 'viral' })).toEqual(before);
    expect((await card(seeded.breakout.clusterId)).sourceModeration).toEqual({
      explicit: false,
      labels: [],
    });
  });
});

describe('Viral Now', () => {
  it('shows untriaged breakouts with real viral evidence by virality', async () => {
    expect(await ids({ view: 'viral' })).toEqual([
      seeded.breakout.clusterId,
      seeded.provisional.clusterId,
    ]);
    // 5-day-old "Top 10" is outside the window; TikTok has no score; unscored has none yet.
    const s = await getSummary(db, NOW);
    expect(s.viralNow).toBe(2);
  });

  it('drops a candidate once it is triaged (saved, rejected, used)', async () => {
    await setSaved(db, { clusterId: seeded.breakout.clusterId, saved: true, now: later(1) });
    expect(await ids({ view: 'viral' })).toEqual([seeded.provisional.clusterId]);
  });

  /** A 10-day-old video measured at `[hoursAgo, views]` readings. */
  const oldVideo = (id: string, snapshots: [number, number][]) =>
    seedCandidate(db, {
      platform: 'youtube',
      platformVideoId: id,
      title: `old video ${id}`,
      publishedAt: hoursAgo(240),
      firstDiscoveredAt: hoursAgo(snapshots[0]![0]),
      snapshots: snapshots.map(([h, views]) => ({ at: hoursAgo(h), views })),
      sightings: [{ source: 'youtube', key: `search:${id}`, at: hoursAgo(snapshots[0]![0]) }],
    });

  it('keeps an old video out of the 48h window unless a recent measurement shows a revival', async () => {
    // Evidence alone is not enough outside the window: the 5-day-old "Top 10" stays out.
    const lower = (await getFeed(db, { now: NOW, pageSize: 100 })).items.find(
      (i) => i.clusterId === seeded.lower.clusterId,
    )!;
    expect(lower.viralEvidence).toBe(true);
    expect(lower.viralRevival).toBe(false);
    expect(await ids({ view: 'viral' })).not.toContain(seeded.lower.clusterId);

    const tail = await oldVideo('vdOldTail01', [
      [4, 5_000_000],
      [0, 5_010_000],
    ]);
    const revived = await oldVideo('vdRevived01', [
      [4, 5_000_000],
      [0, 5_400_000],
    ]);
    const staleRevival = await oldVideo('vdOldRevival', [
      [100, 5_000_000],
      [96, 5_400_000],
    ]);
    const viral = await ids({ view: 'viral' });
    expect(viral).toContain(revived.clusterId);
    expect(viral).not.toContain(tail.clusterId);
    // A revival measured days ago is not "now".
    expect(viral).not.toContain(staleRevival.clusterId);
  });

  it('uses a configurable window (default 48h)', async () => {
    expect(VIRAL_NOW_HOURS).toBe(48);
    const fresh = await seedCandidate(db, {
      platform: 'youtube',
      platformVideoId: 'vdFresh0010h',
      title: 'ten hours old, one snapshot',
      publishedAt: hoursAgo(10),
      firstDiscoveredAt: hoursAgo(1),
      snapshots: [{ at: hoursAgo(1), views: 300_000 }],
      sightings: [{ source: 'youtube', key: 'search:fresh', at: hoursAgo(1) }],
    });
    expect(await ids({ view: 'viral' })).toContain(fresh.clusterId);
    // 6h: the 10h-old video (no measurement) falls outside; the 2h-old clip stays.
    const narrow = await ids({ view: 'viral', viralNowHours: 6 });
    expect(narrow).toContain(seeded.provisional.clusterId);
    expect(narrow).not.toContain(fresh.clusterId);
    // The 11h-old breakout stays: measured right now and accelerating (revival rule).
    expect(narrow).toContain(seeded.breakout.clusterId);
    // A week: the 5-day-old video with real evidence comes back in.
    expect(await ids({ view: 'viral' })).not.toContain(seeded.lower.clusterId);
    expect(await ids({ view: 'viral', viralNowHours: 168 })).toContain(seeded.lower.clusterId);
    expect((await getSummary(db, NOW, { viralNowHours: 6 })).viralNow).toBe(2);
    expect((await getSummary(db, NOW)).viralNow).toBe(3);
  });

  it('metric-less candidates never qualify, whatever their freshness', async () => {
    const native = await seedCandidate(db, {
      platform: 'bluesky',
      platformVideoId: 'at://did:plc:x/app.bsky.feed.post/fresh',
      title: null,
      publishedAt: hoursAgo(0.3),
      firstDiscoveredAt: hoursAgo(0.3),
      snapshots: [{ at: hoursAgo(0.3), likes: 0, comments: 0 }],
      sightings: [{ source: 'bluesky', key: 'at://fresh', at: hoursAgo(0.3) }],
    });
    expect(await ids({ view: 'viral' })).not.toContain(native.clusterId);
    expect(await ids({ view: 'unreviewed' })).toContain(native.clusterId);
  });
});

describe('Saved workflow', () => {
  it('save → appears in Saved; unsave → back to unreviewed, not rejected', async () => {
    await setSaved(db, { clusterId: seeded.breakout.clusterId, saved: true, now: later(1) });
    expect(await ids({ view: 'saved' })).toEqual([seeded.breakout.clusterId]);
    expect((await card(seeded.breakout.clusterId)).inbox).toMatchObject({
      saved: true,
      used: false,
    });
    await setSaved(db, { clusterId: seeded.breakout.clusterId, saved: false, now: later(2) });
    expect(await ids({ view: 'saved' })).toEqual([]);
    expect(await ids({ view: 'unreviewed' })).toContain(seeded.breakout.clusterId);
    expect((await card(seeded.breakout.clusterId)).review.label).toBe('Unreviewed');
  });

  it('unsave never undoes "already used"', async () => {
    await recordReview(db, {
      clusterId: seeded.breakout.clusterId,
      status: 'already_used',
      now: later(1),
    });
    const r = await setSaved(db, {
      clusterId: seeded.breakout.clusterId,
      saved: false,
      now: later(2),
    });
    expect(r.created).toBe(false);
    expect(await ids({ view: 'used' })).toEqual([seeded.breakout.clusterId]);
  });
});

describe('Obtained workflow', () => {
  it('records obtained with time and note, idempotently, without marking used', async () => {
    const first = await recordAcquisition(db, {
      clusterId: seeded.breakout.clusterId,
      status: 'obtained',
      note: 'from the creator',
      videoId: seeded.breakout.videoId,
      now: later(1),
    });
    expect(first.created).toBe(true);
    const again = await recordAcquisition(db, {
      clusterId: seeded.breakout.clusterId,
      status: 'obtained',
      note: 'from the creator',
      videoId: seeded.breakout.videoId,
      now: later(2),
    });
    expect(again.created).toBe(false);
    const c = await card(seeded.breakout.clusterId);
    expect(c.inbox).toMatchObject({
      obtained: true,
      used: false,
      obtainedNote: 'from the creator',
    });
    expect(new Date(c.inbox.obtainedAt!).toISOString()).toBe(later(1).toISOString());
    expect(await ids({ view: 'obtained' })).toEqual([seeded.breakout.clusterId]);
    // Obtained is not a triage decision: it is still in Viral Now.
    expect(await ids({ view: 'viral' })).toContain(seeded.breakout.clusterId);
    // Used later → leaves the Obtained view (obtained, not yet used) but stays obtained.
    await recordReview(db, {
      clusterId: seeded.breakout.clusterId,
      status: 'already_used',
      now: later(3),
    });
    expect(await ids({ view: 'obtained' })).toEqual([]);
    expect((await card(seeded.breakout.clusterId)).inbox).toMatchObject({
      obtained: true,
      used: true,
    });
  });

  it('rejects a representation from another candidate and unknown statuses', async () => {
    await expect(
      recordAcquisition(db, {
        clusterId: seeded.breakout.clusterId,
        status: 'obtained',
        videoId: seeded.lower.videoId,
      }),
    ).rejects.toThrow(ReviewError);
    await expect(
      recordAcquisition(db, { clusterId: seeded.breakout.clusterId, status: 'downloaded' }),
    ).rejects.toThrow(/unknown acquisition status/);
  });
});

describe('Already used protection', () => {
  it('used candidates leave Viral Now and Unreviewed but stay in the Used history', async () => {
    await recordReview(db, {
      clusterId: seeded.breakout.clusterId,
      status: 'already_used',
      now: later(1),
    });
    expect(await ids({ view: 'viral' })).not.toContain(seeded.breakout.clusterId);
    expect(await ids({ view: 'unreviewed' })).not.toContain(seeded.breakout.clusterId);
    expect(await ids({ view: 'used' })).toEqual([seeded.breakout.clusterId]);
  });

  it('a repost confirmed as the same clip inherits "used" and never appears fresh', async () => {
    await recordReview(db, {
      clusterId: seeded.breakout.clusterId,
      status: 'already_used',
      now: later(1),
    });
    const { repost, pairId } = await confirmedRepost();
    // Before confirmation it is shown separately, with a clear warning.
    const before = await card(repost.clusterId);
    expect(before.possibleDuplicateOfUsed).toBe(true);
    expect(before.duplicateStatus).toMatch(/already used/);
    await confirmDuplicate(db, pairId, { now: later(2) });
    const used = await ids({ view: 'used' });
    expect(used).toEqual([seeded.breakout.clusterId]);
    expect(await ids({ view: 'unreviewed' })).not.toContain(repost.clusterId);
    expect(await ids({ view: 'viral' })).not.toContain(seeded.breakout.clusterId);
  });
});

describe('Representations and Open original', () => {
  it('one inbox item per clip, with every confirmed representation as a source link', async () => {
    const { repost, pairId } = await confirmedRepost();
    await confirmDuplicate(db, pairId, { now: later(1) });
    const all = await ids({ view: 'all' });
    expect(all).not.toContain(repost.clusterId);
    const c = await card(seeded.breakout.clusterId);
    expect(c.canonicalUrl).toBe('https://example.test/youtube/vdFixture01');
    expect(c.representations.map((r) => [r.platform, r.url, r.isRepresentative])).toEqual([
      ['YouTube', 'https://example.test/youtube/vdFixture01', true],
      ['TikTok', 'https://example.test/tiktok/7411111111111111111', false],
    ]);
    expect(c.access).toEqual({
      sourceLink: true,
      mediaDownload: false,
      label: 'Source link only (no official download)',
    });
    expect(c.duplicateStatus).toBe('1 confirmed alternate representation');
  });

  it('claims a download only for an official asset', async () => {
    await db.insert(schema.mediaAssets).values({
      videoId: seeded.breakout.videoId,
      kind: 'official_download',
      url: 'https://rights-holder.example/clip.mp4',
      provider: 'rights-holder',
    });
    const c = await card(seeded.breakout.clusterId);
    expect(c.access.mediaDownload).toBe(true);
    expect(c.representations[0]!.mediaDownload).toBe(true);
    // Expired assets do not count.
    await db.update(schema.mediaAssets).set({ expiresAt: hoursAgo(1) });
    expect((await card(seeded.breakout.clusterId)).access.mediaDownload).toBe(false);
  });

  it('cards work without a thumbnail or metrics', async () => {
    const tiktok = await card(seeded.insufficient.clusterId);
    expect(tiktok.metrics).toBeNull();
    expect(tiktok.representations).toHaveLength(1);
    const twitch = await card(seeded.provisional.clusterId);
    expect(twitch.thumbnailUrl).toBeNull();
    expect(twitch.canonicalUrl).toMatch(/^https:\/\//);
  });
});

describe('quick filters and sorting', () => {
  it('filters by label, creator (name or @handle), platform, score and freshness', async () => {
    expect(await ids({ label: 'animals' })).toEqual([seeded.breakout.clusterId]);
    expect(await ids({ creator: 'fixture pets' })).toEqual([seeded.breakout.clusterId]);
    expect(await ids({ creator: '@FixtureStreamer' })).toEqual([seeded.provisional.clusterId]);
    expect(await ids({ platform: 'twitch', view: 'viral' })).toEqual([
      seeded.provisional.clusterId,
    ]);
    expect(await ids({ minScore: 90, view: 'all' })).toEqual([seeded.breakout.clusterId]);
    expect(await ids({ discoveredWithinHours: 1 })).toEqual([
      seeded.provisional.clusterId,
      seeded.unscored.clusterId,
    ]);
  });

  it('sorts without comparing unavailable values as zero', async () => {
    // Most viewed: candidates without views come last, never as "0 views".
    const byViews = await ids({}, 'views');
    expect(byViews.slice(0, 3)).toEqual([
      seeded.lower.clusterId,
      seeded.breakout.clusterId,
      seeded.provisional.clusterId,
    ]);
    expect(byViews.slice(3).sort()).toEqual(
      [seeded.insufficient.clusterId, seeded.unscored.clusterId].sort(),
    );
    // Newest: by publish time (else discovery).
    expect((await ids({}, 'newest'))[0]).toBe(seeded.unscored.clusterId);
    expect((await ids({}, 'discovered'))[0]).toBe(seeded.unscored.clusterId);
    // Fastest growing: only measured growth ranks (platform-normalized views/h; the old
    // 5M-view video gains 25k/h vs the breakout's 23.7k/h); the rest follow.
    expect((await ids({}, 'growth')).slice(0, 2)).toEqual([
      seeded.lower.clusterId,
      seeded.breakout.clusterId,
    ]);
  });

  it('paginates every sort with a stable cursor', async () => {
    for (const sort of ['views', 'newest', 'growth', 'discovered', 'virality'] as const) {
      const all = await ids({}, sort);
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 10; i++) {
        const page = await getFeed(db, { now: NOW, sort, pageSize: 2, cursor });
        seen.push(...page.items.map((x) => x.clusterId));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(seen, sort).toEqual(all);
    }
  });
});

describe('bulk actions', () => {
  const targets = () => [seeded.breakout.clusterId, seeded.provisional.clusterId];

  it('bulk save and bulk obtained', async () => {
    const saved = await bulkApply(db, { clusterIds: targets(), action: 'save', now: later(1) });
    expect(saved.applied.sort()).toEqual(targets().sort());
    expect((await ids({ view: 'saved' })).sort()).toEqual(targets().sort());
    const obtained = await bulkApply(db, {
      clusterIds: targets(),
      action: 'obtained',
      now: later(2),
    });
    expect(obtained.applied).toHaveLength(2);
    expect((await ids({ view: 'obtained' })).sort()).toEqual(targets().sort());
    // Repeating is a no-op, not a duplicate record.
    expect(
      (await bulkApply(db, { clusterIds: targets(), action: 'obtained', now: later(3) })).unchanged,
    ).toHaveLength(2);
  });

  it('bulk already-used collapses merged ids to one clip and reports bad ids', async () => {
    const { repost, pairId } = await confirmedRepost();
    await confirmDuplicate(db, pairId, { now: later(1) });
    const r = await bulkApply(db, {
      clusterIds: [
        seeded.breakout.clusterId,
        repost.clusterId,
        '00000000-0000-4000-8000-000000000000',
      ],
      action: 'used',
      now: later(2),
    });
    expect(r.applied).toEqual([seeded.breakout.clusterId]);
    expect(r.failed).toEqual([
      { clusterId: '00000000-0000-4000-8000-000000000000', error: 'candidate not found' },
    ]);
    expect(await ids({ view: 'used' })).toEqual([seeded.breakout.clusterId]);
    await expect(bulkApply(db, { clusterIds: targets(), action: 'publish' })).rejects.toThrow(
      /unknown bulk action/,
    );
  });
});

describe('export', () => {
  it('exports metadata and links (CSV/JSON) for the Saved view', async () => {
    await setSaved(db, { clusterId: seeded.breakout.clusterId, saved: true, now: later(1) });
    await recordAcquisition(db, {
      clusterId: seeded.breakout.clusterId,
      status: 'obtained',
      now: later(2),
    });
    const rows = await getExportRows(db, { filters: { view: 'saved' }, now: NOW });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: 'Cat discovers the vacuum cleaner',
      creator: 'Fixture Pets',
      platform: 'YouTube',
      canonicalUrl: 'https://example.test/youtube/vdFixture01',
      alternates: [],
      viralityScore: 94.2,
      labels: ['animals', 'funny', 'unexpected'],
      durationSeconds: 42,
      rights: 'Unknown',
      review: 'Saved',
      obtained: true,
      sourceLinkAvailable: true,
      mediaDownloadAvailable: false,
    });
    const csv = toCsv(rows);
    expect(csv.split('\r\n')[0]).toBe(
      'title,creator,creator_handle,platform,canonical_url,alternate_urls,virality_score,score_state,labels,platform_labels,duration_seconds,published_at,views,rights,review,obtained,obtained_at,obtained_note,possible_duplicates,media_download_available,cluster_id',
    );
    expect(csv).toContain(
      'Cat discovers the vacuum cleaner,Fixture Pets,,YouTube,https://example.test/youtube/vdFixture01,,94.2,scored,"animals, funny, unexpected",,42,',
    );
    const json = JSON.parse(toJson(rows, NOW)) as { count: number; note: string };
    expect(json.count).toBe(1);
    expect(json.note).toMatch(/No media files/);
  });

  it('one row per clip: merged/duplicate selections collapse and list alternates', async () => {
    const { repost, pairId } = await confirmedRepost();
    await confirmDuplicate(db, pairId, { now: later(1) });
    const rows = await getExportRows(db, {
      clusterIds: [repost.clusterId, seeded.breakout.clusterId, seeded.provisional.clusterId],
    });
    expect(rows.map((r) => r.clusterId)).toEqual([
      seeded.breakout.clusterId,
      seeded.provisional.clusterId,
    ]);
    expect(rows[0]!.alternates).toEqual([
      { platform: 'TikTok', url: 'https://example.test/tiktok/7411111111111111111' },
    ]);
    expect(toCsv(rows)).toContain('TikTok: https://example.test/tiktok/7411111111111111111');
  });

  it('escapes CSV cells and neutralizes spreadsheet formulas', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('a, b')).toBe('"a, b"');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell(-3)).toBe('-3');
    expect(csvCell(null)).toBe('');
  });
});

describe('creator history', () => {
  it('lists other candidates from the same creator (bounded)', async () => {
    const other = await seedCandidate(db, {
      platform: 'youtube',
      platformVideoId: 'vdFixture09',
      title: 'Cat vs cucumber',
      firstDiscoveredAt: hoursAgo(30),
      creator: 'Fixture Pets',
      sightings: [{ source: 'youtube', key: 'search:cats', at: hoursAgo(30) }],
    });
    const history = await getCreatorHistory(db, seeded.breakout.clusterId);
    expect(history.map((h) => h.clusterId)).toEqual([other.clusterId]);
    expect(await getCreatorHistory(db, seeded.unscored.clusterId)).toEqual([]);
  });
});

describe('discovery health', () => {
  it('reports last success, recent finds, quarantined items, quota, errors and unconfigured adapters', async () => {
    const [yt] = await db
      .select()
      .from(schema.sources)
      .where(sqlEq(schema.sources.name, 'youtube'));
    const [tw] = await db.select().from(schema.sources).where(sqlEq(schema.sources.name, 'twitch'));
    await db
      .update(schema.sources)
      .set({ enabled: true, dailyQuotaBudgets: { 'search.list': 100 } })
      .where(sqlEq(schema.sources.id, yt!.id));
    await db.insert(schema.discoveryRuns).values([
      {
        sourceId: yt!.id,
        trigger: 'schedule',
        status: 'succeeded',
        itemsFound: 40,
        itemsNew: 12,
        stats: { invalid: 2 },
        createdAt: hoursAgo(2),
        finishedAt: hoursAgo(2),
      },
      {
        sourceId: tw!.id,
        trigger: 'schedule',
        status: 'succeeded',
        itemsFound: 5,
        itemsNew: 1,
        createdAt: hoursAgo(40),
        finishedAt: hoursAgo(40),
      },
      {
        sourceId: tw!.id,
        trigger: 'schedule',
        status: 'failed',
        error: 'upstream 503',
        createdAt: hoursAgo(1),
        finishedAt: hoursAgo(1),
      },
    ]);
    await db.insert(schema.apiUsage).values({
      sourceId: yt!.id,
      usageDate: NOW.toISOString().slice(0, 10),
      quotaBucket: 'search.list',
      unitsUsed: 30,
    });
    const health = await getDiscoveryHealth(db, {
      now: NOW,
      adapters: [
        {
          id: 'youtube',
          displayName: 'YouTube',
          platform: 'youtube',
          configured: true,
          missingEnv: [],
        },
        {
          id: 'twitch',
          displayName: 'Twitch',
          platform: 'twitch',
          configured: true,
          missingEnv: [],
        },
        {
          id: 'bluesky',
          displayName: 'Bluesky',
          platform: 'bluesky',
          configured: false,
          missingEnv: ['BLUESKY_APPVIEW_URL'],
        },
      ],
      planned: [{ id: 'reddit', reason: 'access-gated' }],
    });
    const ytHealth = health.adapters.find((a) => a.id === 'youtube')!.sources[0]!;
    expect(ytHealth).toMatchObject({
      state: 'healthy',
      runs24h: 1,
      found24h: 40,
      new24h: 12,
      quarantined24h: 2,
    });
    expect(ytHealth.quota).toEqual([{ bucket: 'search.list', used: 30, budget: 100 }]);
    const twHealth = health.adapters.find((a) => a.id === 'twitch')!.sources[0]!;
    expect(twHealth).toMatchObject({
      state: 'failing',
      lastError: 'upstream 503',
      lastRunStatus: 'failed',
    });
    expect(health.adapters.find((a) => a.id === 'bluesky')).toMatchObject({
      configured: false,
      missingEnv: ['BLUESKY_APPVIEW_URL'],
    });
    expect(health.adapters.find((a) => a.id === 'bluesky')!.sources[0]!.state).toBe('unconfigured');
    // manual-url has sources in the fixtures but is not in this adapter list → listed as orphaned.
    expect(health.orphanSources.map((s) => s.name)).toEqual(['manual-url']);
    expect(health.planned).toEqual([{ id: 'reddit', reason: 'access-gated' }]);
    expect(health.pipeline.videosDiscovered24h).toBe(5);
  });
});
