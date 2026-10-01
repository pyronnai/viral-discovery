import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema, type AnyDatabase } from '@vd/db';
import {
  assessPair,
  confirmDuplicate,
  creatorKeys,
  rejectDuplicate,
  tokenize,
  type MatchProfile,
} from '@vd/dedupe';
import { ReviewError, recordReview, setRights } from './actions.ts';
import { getCandidate, mergedInto } from './detail.ts';
import { getFeed, getSummary } from './feed.ts';
import { conflictViews, toCardView, toDuplicateView, versionViews } from './present.ts';
import { NOW, ROLES, createTestDb, hoursAgo, seedCandidate, seedFeed } from './testing.ts';

let db: AnyDatabase;
let close: () => Promise<void>;
let seeded: Awaited<ReturnType<typeof seedFeed>>;
let repost: { clusterId: string; videoId: string };
let candidateId: string;

const profile = (over: Partial<MatchProfile>): MatchProfile => ({
  videoId: 'x',
  platform: 'youtube',
  durationMs: null,
  publishedAt: null,
  creatorKeys: [],
  phash: 'a3f09c5e71b2d4c8',
  tokens: tokenize('Cat discovers the vacuum cleaner'),
  references: [],
  ...over,
});

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  seeded = await seedFeed(db);
  repost = await seedCandidate(db, {
    platform: 'tiktok',
    platformVideoId: '7499999999999999999',
    title: 'this cat discovered the vacuum cleaner 😭 #cat #fyp',
    thumbnailUrl: 'https://p16-sign.tiktokcdn-us.com/repost.jpeg',
    firstDiscoveredAt: hoursAgo(4),
    creator: 'repost.daily',
    sightings: [{ source: 'manual-url', key: 'tiktok:7499999999999999999', at: hoursAgo(4) }],
  });
  // A detector suggestion (evidence from the real assessment): near-identical thumbnail + title, no duration.
  const assessment = assessPair(
    profile({
      videoId: seeded.breakout.videoId,
      durationMs: 42_000,
      creatorKeys: creatorKeys('Fixture Pets'),
    }),
    profile({
      videoId: repost.videoId,
      platform: 'tiktok',
      phash: 'a3f09c5e71b2d4c9',
      tokens: tokenize('this cat discovered the vacuum cleaner 😭 #cat #fyp'),
    }),
  );
  expect(assessment.decision).toBe('possible');
  const [a, b] = [seeded.breakout.videoId, repost.videoId].sort() as [string, string];
  const [row] = await db
    .insert(schema.duplicateCandidates)
    .values({
      videoAId: a,
      videoBId: b,
      confidence: assessment.confidence,
      evidence: { ...assessment.evidence },
      reasons: assessment.reasons,
      detectorVersion: assessment.detectorVersion,
      firstDetectedAt: hoursAgo(1),
    })
    .returning();
  candidateId = row!.id;
});
afterEach(async () => {
  await close();
});

const card = async (clusterId: string) => {
  const row = (await getFeed(db, { now: NOW, pageSize: 100 })).items.find(
    (i) => i.clusterId === clusterId,
  );
  return row ? toCardView(row, ROLES, NOW) : null;
};

describe('possible duplicates in the feed and detail page', () => {
  it('shows a small indicator on both cards and filters/counts them', async () => {
    expect((await card(seeded.breakout.clusterId))?.duplicatesLabel).toBe('1 possible duplicate');
    expect((await card(repost.clusterId))?.duplicatesLabel).toBe('1 possible duplicate');
    expect((await card(seeded.lower.clusterId))?.duplicatesLabel).toBeNull();
    const only = await getFeed(db, { now: NOW, filters: { possibleDuplicates: true } });
    expect(only.items.map((i) => i.clusterId).sort()).toEqual(
      [seeded.breakout.clusterId, repost.clusterId].sort(),
    );
    expect((await getSummary(db)).possibleDuplicates).toBe(2);
  });

  it('lists the other version with platform, duration, confidence, evidence and why a human must decide', async () => {
    const detail = (await getCandidate(db, seeded.breakout.clusterId))!;
    expect(detail.possibleDuplicates).toHaveLength(1);
    const view = toDuplicateView(detail.possibleDuplicates[0]!);
    expect(view).toMatchObject({
      platform: 'TikTok',
      title: 'this cat discovered the vacuum cleaner 😭 #cat #fyp',
      duration: '—',
      href: `/candidates/${repost.clusterId}`,
      canonicalUrl: 'https://example.test/tiktok/7499999999999999999',
    });
    expect(view.confidenceText).toMatch(/^\d+%$/);
    expect(view.evidence[0]).toBe('Thumbnail: identical (distance 1/64)');
    expect(view.evidence[1]).toBe('Duration: unknown on at least one side');
    expect(view.needsHumanBecause).toContain('duration unknown on one side');
    // Nothing is shared before confirmation.
    await recordReview(db, {
      clusterId: seeded.breakout.clusterId,
      status: 'approved',
      now: hoursAgo(0.5),
    });
    expect((await card(repost.clusterId))?.review.label).toBe('Unreviewed');
  });
});

describe('confirm / reject', () => {
  it('confirm merges into one card showing both representations; the old id redirects', async () => {
    await confirmDuplicate(db, candidateId, { now: NOW });
    expect(await card(repost.clusterId)).toBeNull();
    expect(await mergedInto(db, repost.clusterId)).toBe(seeded.breakout.clusterId);
    const merged = (await card(seeded.breakout.clusterId))!;
    expect(merged.versions).toBe(2);
    expect(merged.versionPlatforms).toEqual(['TikTok', 'YouTube']);
    expect(merged.duplicatesLabel).toBeNull();
    // Scores still come from the representative (YouTube, canonical metrics); not re-counted as a new discovery.
    expect(merged.platform).toBe('YouTube');
    const detail = (await getCandidate(db, seeded.breakout.clusterId))!;
    const versions = versionViews(detail);
    expect(versions.map((v) => [v.platform, v.isRepresentative, v.joined])).toEqual([
      ['YouTube', true, 'confirmed same as TikTok by owner'],
      ['TikTok', false, 'confirmed same as YouTube by owner'],
    ]);
    // Sightings of both representations remain sightings of the cluster.
    expect(detail.sightings.map((s) => s.videoId)).toContain(repost.videoId);
    expect(
      (await getFeed(db, { now: NOW })).items.filter(
        (i) => i.clusterId === seeded.breakout.clusterId,
      ),
    ).toHaveLength(1);
  });

  it('reject removes the indicator and keeps the decision visible', async () => {
    await rejectDuplicate(db, candidateId, { now: NOW, note: 'different cat' });
    expect((await card(seeded.breakout.clusterId))?.duplicatesLabel).toBeNull();
    const detail = (await getCandidate(db, seeded.breakout.clusterId))!;
    expect(detail.possibleDuplicates).toEqual([]);
    expect(detail.rejectedDuplicates.map((d) => [d.status, d.note])).toEqual([
      ['rejected', 'different cat'],
    ]);
  });
});

describe('merge conflicts', () => {
  it('shows a review conflict instead of silently choosing, until a new decision is recorded', async () => {
    await recordReview(db, {
      clusterId: seeded.breakout.clusterId,
      status: 'approved',
      now: hoursAgo(2),
    });
    await recordReview(db, {
      clusterId: repost.clusterId,
      status: 'rejected',
      note: 'repost account',
      now: hoursAgo(1),
    });
    await confirmDuplicate(db, candidateId, { now: NOW });

    const c = (await card(seeded.breakout.clusterId))!;
    expect(c.review).toMatchObject({ status: null, label: 'Review conflict' });
    expect(c.conflicts).toEqual({ review: true, rights: false });
    const conflicted = await getFeed(db, { now: NOW, filters: { review: 'conflict' } });
    expect(conflicted.items.map((i) => i.clusterId)).toEqual([seeded.breakout.clusterId]);
    const unreviewed = await getFeed(db, { now: NOW, filters: { review: 'unreviewed' } });
    expect(unreviewed.items.map((i) => i.clusterId)).not.toContain(seeded.breakout.clusterId);
    expect((await getSummary(db)).conflicts).toBe(1);

    const detail = (await getCandidate(db, seeded.breakout.clusterId))!;
    const [view] = conflictViews(detail.summary, detail.merges);
    expect(view).toMatchObject({
      kind: 'review',
      reason: 'different decisions (approved vs rejected)',
    });
    expect(view!.sides).toEqual([
      { versions: 'YouTube', value: 'Approved' },
      { versions: 'TikTok', value: 'Rejected' },
    ]);
    // Both histories are preserved; the carried-over event is marked.
    expect(detail.reviews.map((r) => [r.status, r.originClusterId])).toEqual([
      ['rejected', repost.clusterId],
      ['approved', null],
    ]);
    // Re-choosing the latest carried-over status still records a resolving decision.
    await recordReview(db, {
      clusterId: seeded.breakout.clusterId,
      status: 'rejected',
      now: new Date(NOW.getTime() + 60_000),
    });
    expect((await card(seeded.breakout.clusterId))!.review).toMatchObject({
      status: 'rejected',
      label: 'Rejected',
    });
  });

  it('flags rights that cannot be combined and never shows them as granted', async () => {
    await setRights(db, {
      clusterId: repost.clusterId,
      status: 'granted',
      rightsHolder: 'repost.daily',
      now: hoursAgo(1),
    });
    await confirmDuplicate(db, candidateId, { now: NOW });
    const c = (await card(seeded.breakout.clusterId))!;
    expect(c.rights).toEqual({ status: 'conflict', label: 'Needs review (merge conflict)' });
    expect((await getFeed(db, { now: NOW, filters: { rights: 'granted' } })).items).toEqual([]);
    const detail = (await getCandidate(db, seeded.breakout.clusterId))!;
    expect(conflictViews(detail.summary, detail.merges)[0]).toMatchObject({
      kind: 'rights',
      reason: '"granted" was recorded for one representation only',
    });
    await setRights(db, {
      clusterId: seeded.breakout.clusterId,
      status: 'requested',
      now: new Date(NOW.getTime() + 60_000),
    });
    expect((await card(seeded.breakout.clusterId))!.rights.status).toBe('requested');
  });

  it('refuses decisions on a merged-away cluster id', async () => {
    await confirmDuplicate(db, candidateId, { now: NOW });
    await expect(
      recordReview(db, { clusterId: repost.clusterId, status: 'approved' }),
    ).rejects.toThrow(ReviewError);
  });
});
