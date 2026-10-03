/**
 * The provider-neutral TikTok adapter through the real pipeline, with an in-memory
 * source (no network, no paid provider): identity, sightings, snapshots, reference
 * enrichment and refresh. The adapter is not wired into the registry because no
 * free TikTok source exists yet; these tests keep it ready for one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createFakeFetch, route } from '@vd/adapter-contract/testing';
import { createBlueskyAdapter } from '@vd/adapter-bluesky';
import { createTikTokAdapter, type TikTokPublicPost } from '@vd/adapter-tiktok';
import { createFakeTikTokProvider } from '@vd/adapter-tiktok/testing';
import { schema, type AnyDatabase } from '@vd/db';
import searchPosts from '../../adapters/bluesky/fixtures/searchPosts.json' with { type: 'json' };
import fixture from '../../adapters/tiktok/fixtures/public-posts.json' with { type: 'json' };
import { runDiscovery } from './ingest.ts';
import { refreshMetrics } from './refresh.ts';
import { createTestDb, testClock, testDeps } from './testing.ts';

const posts = fixture as TikTokPublicPost[];
let db: AnyDatabase;
let close: () => Promise<void>;
let clock: ReturnType<typeof testClock>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock = testClock('2026-10-03T12:00:00Z');
});
afterEach(async () => {
  await close();
});

const tiktok = (source = createFakeTikTokProvider(posts)) =>
  createTikTokAdapter({ provider: source });
const search = (q: string) => ({
  adapterId: 'tiktok',
  kind: 'search' as const,
  params: { q, maxResults: 10 },
  limit: 50,
});
const videosOf = () => db.select().from(schema.videos);
const sightingsOf = (videoId: string) =>
  db
    .select({ key: schema.sightings.observationKey, source: schema.sources.name })
    .from(schema.sightings)
    .innerJoin(schema.sources, eq(schema.sources.id, schema.sightings.sourceId))
    .where(eq(schema.sightings.videoId, videoId));
const snapshotsOf = (videoId: string) =>
  db.select().from(schema.metricSnapshots).where(eq(schema.metricSnapshots.videoId, videoId));

describe('provider-neutral TikTok adapter in the pipeline', () => {
  it('one canonical video per TikTok id, one sighting per query that found it', async () => {
    const deps = testDeps(db, [tiktok()], clock.now);
    const first = await runDiscovery(deps, search('funny'));
    clock.advance(60_000);
    const second = await runDiscovery(deps, search('funny animals'));
    // 2 videos; the photo/carousel post is quarantined.
    expect(first).toMatchObject({ status: 'succeeded', itemsFound: 3, itemsNew: 2 });
    expect(first.stats).toMatchObject({ ingested: 2, invalid: 1 });
    expect(second).toMatchObject({ itemsNew: 0, stats: { videosUpdated: 2 } });
    const cat = (await videosOf()).find((v) => v.platformVideoId === '7550000000000000001')!;
    expect((await sightingsOf(cat.id)).map((s) => s.key).sort()).toEqual([
      'search:funny',
      'search:funny animals',
    ]);
    expect(cat).toMatchObject({
      platform: 'tiktok',
      canonicalUrl: 'https://www.tiktok.com/@fixture.pets/video/7550000000000000001',
      durationMs: 18_000,
      publishedAt: new Date('2026-10-03T08:00:00Z'),
      creatorHandle: 'fixture.pets',
    });
  });

  it('writes views/likes/comments/shares; unreported metrics stay NULL with a reason', async () => {
    await runDiscovery(testDeps(db, [tiktok()], clock.now), search('funny'));
    const videos = await videosOf();
    const cat = videos.find((v) => v.platformVideoId === '7550000000000000001')!;
    const fail = videos.find((v) => v.platformVideoId === '7550000000000000002')!;
    expect(await snapshotsOf(cat.id)).toEqual([
      expect.objectContaining({
        views: 3_200_000,
        likes: 410_000,
        comments: 6_100,
        shares: 52_000,
      }),
    ]);
    const [s] = await snapshotsOf(fail.id);
    expect(s).toMatchObject({ views: 41_000, likes: null, comments: 0, shares: 0 });
    expect(s!.unavailable).toMatchObject({ likes: 'unknown' });
  });

  it('a TikTok link found on Bluesky is enriched in one batched lookup, keeping the Bluesky sighting', async () => {
    const bluesky = createBlueskyAdapter({
      fetch: createFakeFetch([
        route('/xrpc/app.bsky.feed.searchPosts', { body: { ...searchPosts, cursor: undefined } }),
      ]),
      expandShortLinks: false,
    });
    const linked: TikTokPublicPost = {
      ...posts[0]!,
      videoId: '7412345678901234567',
      url: 'https://www.tiktok.com/@fixture.creator/video/7412345678901234567',
      creatorUsername: 'fixture.creator',
      publishedAt: '2026-10-02T20:00:00.000Z',
      durationSeconds: 21,
      views: 900_000,
    };
    const source = createFakeTikTokProvider([linked]);
    const deps = testDeps(db, [bluesky, tiktok(source)], clock.now);
    const run = await runDiscovery(deps, {
      adapterId: 'bluesky',
      kind: 'search',
      params: { q: 'funny' },
      limit: 50,
    });
    const ref = (await videosOf()).find((v) => v.platformVideoId === '7412345678901234567')!;
    expect(run.stats.enrichment?.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ videoId: ref.id, status: 'enriched', adapterId: 'tiktok' }),
      ]),
    );
    expect(ref).toMatchObject({ durationMs: 21_000, creatorHandle: 'fixture.creator' });
    expect((await sightingsOf(ref.id)).map((s) => s.source)).toEqual(['bluesky']);
    expect((await snapshotsOf(ref.id))[0]).toMatchObject({ views: 900_000 });
    expect(source.calls.filter((c) => c.op === 'lookup')).toHaveLength(1);
  });

  it('refreshes TikTok metrics through the source (batched) into new snapshots', async () => {
    await runDiscovery(testDeps(db, [tiktok()], clock.now), search('funny'));
    clock.advance(2 * 3_600_000);
    const later = posts.map((p) =>
      p.videoId === '7550000000000000001' ? { ...p, views: 4_100_000 } : p,
    );
    const source = createFakeTikTokProvider(later);
    const summary = await refreshMetrics(testDeps(db, [tiktok(source)], clock.now), {
      platform: 'tiktok',
      limit: 10,
    });
    expect(summary).toMatchObject({ requested: 2, snapshotsCreated: 2, error: null });
    expect(source.calls.filter((c) => c.op === 'lookup')).toHaveLength(1);
    const cat = (await videosOf()).find((v) => v.platformVideoId === '7550000000000000001')!;
    expect((await snapshotsOf(cat.id)).map((s) => s.views).sort()).toEqual([3_200_000, 4_100_000]);
  });
});
