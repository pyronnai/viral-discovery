import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { createFakeFetch, route } from '@vd/adapter-contract/testing';
import { createBlueskyAdapter } from '@vd/adapter-bluesky';
import { createManualUrlAdapter } from '@vd/adapter-manual-url';
import { createTwitchAdapter } from '@vd/adapter-twitch';
import { createYouTubeAdapter } from '@vd/adapter-youtube';
import { schema, type AnyDatabase } from '@vd/db';
import mostPopular from '../../adapters/youtube/fixtures/videos-list-mostPopular.json' with { type: 'json' };
import batchStats from '../../adapters/youtube/fixtures/batchGetStats.json' with { type: 'json' };
import quotaError from '../../adapters/youtube/fixtures/error-quota-exceeded.json' with { type: 'json' };
import searchPosts from '../../adapters/bluesky/fixtures/searchPosts.json' with { type: 'json' };
import clips from '../../adapters/twitch/fixtures/clips-by-game.json' with { type: 'json' };
import twitchToken from '../../adapters/twitch/fixtures/token.json' with { type: 'json' };
import oembed from '../../adapters/manual-url/fixtures/tiktok-oembed.json' with { type: 'json' };
import { runDiscovery, runSourceQuery } from './ingest.ts';
import { refreshMetrics } from './refresh.ts';
import { submitUrl, UnsupportedUrlError } from './submit.ts';
import { createTestDb, testClock, testDeps } from './testing.ts';

const HOUR = 3_600_000;
let db: AnyDatabase;
let close: () => Promise<void>;
let clock: ReturnType<typeof testClock>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock = testClock();
});
afterEach(async () => {
  await close();
});

// Page 1 only (no nextPageToken), so each run is exactly one API call.
const chartPage = { ...mostPopular, nextPageToken: undefined };
const youtube = (responses = [route('/youtube/v3/videos', { body: chartPage })]) =>
  createYouTubeAdapter({
    apiKey: 'k',
    fetch: createFakeFetch([
      route('/youtube/v3/videos:batchGetStats', { body: batchStats }),
      route('/youtube/v3/videos', { body: { items: [mostPopular.items[0]] } }, (u) =>
        u.searchParams.has('id'),
      ),
      ...responses,
    ]),
  });
const bluesky = () =>
  createBlueskyAdapter({
    fetch: createFakeFetch([
      route('/xrpc/app.bsky.feed.searchPosts', { body: { ...searchPosts, cursor: undefined } }),
    ]),
  });
const manual = () =>
  createManualUrlAdapter({ fetch: createFakeFetch([route('/oembed', { body: oembed })]) });

const ytTrending = {
  adapterId: 'youtube',
  kind: 'trending' as const,
  params: { regionCode: 'US' },
  limit: 50,
};
const bskySearch = {
  adapterId: 'bluesky',
  kind: 'search' as const,
  params: { q: 'funny' },
  limit: 50,
};

const all = {
  videos: () => db.select().from(schema.videos).orderBy(asc(schema.videos.platformVideoId)),
  sightings: () =>
    db
      .select({
        sighting: schema.sightings,
        source: schema.sources.name,
        platform: schema.videos.platform,
        platformVideoId: schema.videos.platformVideoId,
      })
      .from(schema.sightings)
      .innerJoin(schema.sources, eq(schema.sources.id, schema.sightings.sourceId))
      .innerJoin(schema.videos, eq(schema.videos.id, schema.sightings.videoId)),
  snapshots: () =>
    db
      .select({
        snap: schema.metricSnapshots,
        source: schema.sources.name,
        platformVideoId: schema.videos.platformVideoId,
      })
      .from(schema.metricSnapshots)
      .innerJoin(schema.videos, eq(schema.videos.id, schema.metricSnapshots.videoId))
      .leftJoin(schema.sources, eq(schema.sources.id, schema.metricSnapshots.sourceId))
      .orderBy(asc(schema.metricSnapshots.capturedAt)),
};

describe('runDiscovery (YouTube)', () => {
  it('stores videos, creators, sightings, an initial snapshot, and run stats', async () => {
    const run = await runDiscovery(testDeps(db, [youtube()], clock.now), ytTrending);

    expect(run).toMatchObject({ status: 'succeeded', itemsFound: 3, itemsNew: 2, error: null });
    expect(run.stats).toMatchObject({
      ingested: 2,
      invalid: 1,
      sightingsCreated: 2,
      snapshotsCreated: 2,
      quotaUsed: { default: 1 },
    });
    expect(run.stats.invalidSamples[0]?.externalId).toBe('vdFixture03');

    const videos = await all.videos();
    expect(videos.map((v) => [v.platform, v.platformVideoId, v.availability])).toEqual([
      ['youtube', 'vdFixture01', 'available'],
      ['youtube', 'vdFixture02', 'available'],
    ]);
    expect(videos[0]?.rawPayload).toMatchObject({ id: 'vdFixture01' });
    expect(await db.select().from(schema.creators)).toHaveLength(2);

    const [snap] = (await all.snapshots()).map((s) => s.snap);
    expect(snap).toMatchObject({
      views: 50_000,
      likes: 4_200,
      comments: 310,
      shares: null,
      upvotes: null,
    });
    expect(snap?.unavailable).toEqual({
      shares: 'not_provided_by_platform',
      upvotes: 'not_provided_by_platform',
      upvoteRatio: 'not_provided_by_platform',
    });
    const kitchen = (await all.snapshots()).find((s) => s.platformVideoId === 'vdFixture02')!.snap;
    expect(kitchen).toMatchObject({ views: 910_000, likes: null, comments: null });
    expect(kitchen.unavailable).toMatchObject({ likes: 'unknown', comments: 'unknown' });

    const [runRow] = await db.select().from(schema.discoveryRuns);
    expect(runRow).toMatchObject({
      status: 'succeeded',
      itemsFound: 3,
      itemsNew: 2,
      trigger: 'manual',
    });
    expect(runRow?.request).toMatchObject({
      adapterId: 'youtube',
      kind: 'trending',
      params: { regionCode: 'US' },
    });
    expect(await db.select().from(schema.apiUsage)).toMatchObject([
      { quotaBucket: 'default', unitsUsed: 1 },
    ]);
  });

  it('is idempotent for videos; each run adds one sighting and one snapshot per video', async () => {
    const deps = testDeps(db, [youtube()], clock.now);
    await runDiscovery(deps, ytTrending);
    clock.advance(HOUR);
    const second = await runDiscovery(deps, ytTrending);

    expect(second.itemsNew).toBe(0);
    expect(second.stats.videosUpdated).toBe(2);
    expect(await all.videos()).toHaveLength(2);
    expect(await all.sightings()).toHaveLength(4);
    expect(await all.snapshots()).toHaveLength(4);
    expect(await db.select().from(schema.creators)).toHaveLength(2);
    expect(await db.select().from(schema.apiUsage)).toMatchObject([{ unitsUsed: 2 }]);
  });

  it('never duplicates a sighting or snapshot within one run', async () => {
    const twice = { ...chartPage, items: [mostPopular.items[0], mostPopular.items[0]] };
    const run = await runDiscovery(
      testDeps(db, [youtube([route('/youtube/v3/videos', { body: twice })])], clock.now),
      ytTrending,
    );
    expect(run.stats).toMatchObject({ ingested: 2, sightingsCreated: 1, snapshotsCreated: 1 });
  });

  it('filters by max duration after normalization and records what it filtered', async () => {
    const run = await runDiscovery(testDeps(db, [youtube()], clock.now), {
      ...ytTrending,
      filters: { maxDurationMs: 60_000 },
    });
    expect(run.stats.filtered).toBe(1);
    expect(run.stats.filteredSamples).toEqual([
      {
        externalId: 'vdFixture02',
        platformVideoId: 'vdFixture02',
        reason: 'duration 723000ms > max 60000ms',
      },
    ]);
    expect((await all.videos()).map((v) => v.platformVideoId)).toEqual(['vdFixture01']);
  });

  it('records an empty run', async () => {
    const run = await runDiscovery(
      testDeps(db, [youtube([route('/youtube/v3/videos', { body: { items: [] } })])], clock.now),
      ytTrending,
    );
    expect(run).toMatchObject({ status: 'succeeded', itemsFound: 0, itemsNew: 0 });
  });

  it('marks the run failed on an API error and keeps the reason', async () => {
    const run = await runDiscovery(
      testDeps(
        db,
        [youtube([route('/youtube/v3/videos', { status: 403, body: quotaError })])],
        clock.now,
      ),
      ytTrending,
    );
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/HTTP 403.*quotaExceeded/);
    const [row] = await db.select().from(schema.discoveryRuns);
    expect(row).toMatchObject({ status: 'failed', error: run.error });
  });

  it('enforces the daily budget stored on the source', async () => {
    const deps = testDeps(db, [youtube()], clock.now);
    await runDiscovery(deps, ytTrending);
    await db
      .update(schema.sources)
      .set({ dailyQuotaBudgets: { default: 1 } })
      .where(eq(schema.sources.name, 'youtube'));
    const run = await runDiscovery(deps, ytTrending);
    expect(run.status).toBe('partial');
    expect(run.error).toMatch(/budget for bucket "default" is exhausted/);
  });

  it('rejects unsupported query kinds with the supported ones', async () => {
    await expect(
      runDiscovery(testDeps(db, [youtube()], clock.now), { ...ytTrending, kind: 'search' }),
    ).rejects.toThrow(/does not support "search" discovery \(supports: trending\)/);
  });

  it('runs a stored multi-region SourceQuery', async () => {
    const deps = testDeps(db, [youtube()], clock.now);
    const [source] = await db
      .insert(schema.sources)
      .values({ name: 'yt-comedy', adapterId: 'youtube', enabled: true })
      .returning();
    const [query] = await db
      .insert(schema.sourceQueries)
      .values({
        sourceId: source!.id,
        kind: 'trending',
        params: { regionCode: ['US', 'GB'], videoCategoryId: '23' },
      })
      .returning();
    const run = await runSourceQuery(deps, query!.id, { limit: 100 });
    expect(run.source).toBe('yt-comedy');
    expect(run.stats.quotaUsed).toEqual({ default: 2 });
    // Same video in two regional charts → one video, two sightings, one snapshot.
    expect(await all.videos()).toHaveLength(2);
    expect(await all.sightings()).toHaveLength(4);
    expect(await all.snapshots()).toHaveLength(2);
    const [runRow] = await db.select().from(schema.discoveryRuns);
    expect(runRow?.sourceQueryId).toBe(query!.id);
  });
});

describe('cross-source sightings', () => {
  it('a YouTube video seen on YouTube and linked from Bluesky is one video with two sightings', async () => {
    const deps = testDeps(db, [youtube(), bluesky()], clock.now);
    await runDiscovery(deps, ytTrending);
    clock.advance(HOUR);
    const bsky = await runDiscovery(deps, bskySearch);

    expect(bsky.stats).toMatchObject({ ingested: 4, invalid: 1 });
    const cat = (await all.videos()).filter((v) => v.platformVideoId === 'vdFixture01');
    expect(cat).toHaveLength(1);
    // The reference did not overwrite YouTube's data.
    expect(cat[0]).toMatchObject({
      platform: 'youtube',
      title: 'Cat discovers the vacuum cleaner',
      availability: 'available',
      durationMs: 42_000,
    });

    const sightings = (await all.sightings()).filter((s) => s.platformVideoId === 'vdFixture01');
    expect(sightings.map((s) => s.source).sort()).toEqual(['bluesky', 'youtube']);
    const viaBluesky = sightings.find((s) => s.source === 'bluesky')!.sighting;
    expect(viaBluesky.observationKey).toBe(
      'at://did:plc:fixtureauthor000000000001/app.bsky.feed.post/3fixturepost1',
    );
    expect(viaBluesky.context).toMatchObject({
      postUrl: 'https://bsky.app/profile/did:plc:fixtureauthor000000000001/post/3fixturepost1',
      postAuthor: { handle: 'funnyfinds.fixture.test' },
      postEngagement: { likes: 87, reposts: 12 },
    });

    // Bluesky post engagement never becomes a video metric.
    const catSnapshots = (await all.snapshots()).filter((s) => s.platformVideoId === 'vdFixture01');
    expect(catSnapshots.map((s) => s.source)).toEqual(['youtube']);
  });

  it('a reference seen first is later completed by the canonical platform', async () => {
    const deps = testDeps(db, [youtube(), bluesky()], clock.now);
    await runDiscovery(deps, bskySearch);
    let cat = (await all.videos()).find((v) => v.platformVideoId === 'vdFixture01')!;
    expect(cat).toMatchObject({
      title: 'cat vs vacuum 😂 - YouTube',
      availability: 'unknown',
      durationMs: null,
      creatorId: null,
      rawPayload: null,
    });
    expect(await all.snapshots()).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ platformVideoId: 'vdFixture01' })]),
    );

    clock.advance(HOUR);
    const yt = await runDiscovery(deps, ytTrending);
    expect(yt.itemsNew).toBe(1); // vdFixture02 only; vdFixture01 already existed
    cat = (await all.videos()).find((v) => v.platformVideoId === 'vdFixture01')!;
    // The canonical platform's values replace what the reference filled in.
    expect(cat).toMatchObject({
      title: 'Cat discovers the vacuum cleaner',
      availability: 'available',
      durationMs: 42_000,
      canonicalUrl: 'https://www.youtube.com/watch?v=vdFixture01',
    });
    expect(cat.creatorId).not.toBeNull();
  });

  it('stores native Bluesky videos and linked TikTok/Twitch videos under their own platforms', async () => {
    await runDiscovery(testDeps(db, [bluesky()], clock.now), bskySearch);
    const videos = await all.videos();
    expect(videos.map((v) => v.platform).sort()).toEqual([
      'bluesky',
      'tiktok',
      'twitch',
      'youtube',
    ]);
    const native = videos.find((v) => v.platform === 'bluesky')!;
    expect(native.canonicalUrl).toBe(
      'https://bsky.app/profile/did:plc:fixtureauthor000000000002/post/3fixturepost2',
    );
    const snaps = await all.snapshots();
    expect(snaps.map((s) => s.platformVideoId)).toEqual([native.platformVideoId]);
    expect(snaps[0]?.snap).toMatchObject({ likes: 512, comments: 9, views: null });
  });
});

describe('refreshMetrics', () => {
  it('adds a later snapshot so velocity can be computed from two readings', async () => {
    const deps = testDeps(db, [youtube()], clock.now);
    await runDiscovery(deps, ytTrending);
    clock.advance(6 * HOUR);
    const summary = await refreshMetrics(deps, { platform: 'youtube', limit: 100 });
    expect(summary).toMatchObject({
      requested: 2,
      snapshotsCreated: 2,
      unavailable: 0,
      error: null,
      quotaUsed: { 'videos.batchGetStats': 1 },
    });

    const cat = (await all.snapshots())
      .filter((s) => s.platformVideoId === 'vdFixture01')
      .map((s) => [s.snap.capturedAt.toISOString(), s.snap.views]);
    expect(cat).toEqual([
      ['2026-09-28T12:00:00.000Z', 50_000],
      ['2026-09-28T18:00:00.000Z', 110_000],
    ]);
  });

  it('refreshes videos that were only ever seen through another source', async () => {
    const deps = testDeps(db, [youtube(), bluesky()], clock.now);
    await runDiscovery(deps, bskySearch);
    const summary = await refreshMetrics(deps, { platform: 'youtube', limit: 10 });
    expect(summary.snapshotsCreated).toBe(1);
    const [snap] = await all
      .snapshots()
      .then((s) => s.filter((x) => x.platformVideoId === 'vdFixture01'));
    expect(snap).toMatchObject({ source: 'youtube', snap: { views: 110_000 } });
    const cat = (await all.videos()).find((v) => v.platformVideoId === 'vdFixture01');
    expect(cat?.availability).toBe('available');
  });

  it('fails clearly when no adapter can refresh the platform', async () => {
    await expect(
      refreshMetrics(testDeps(db, [manual()], clock.now), { platform: 'tiktok', limit: 5 }),
    ).rejects.toThrow(/no configured adapter can refresh metrics for "tiktok"/);
  });
});

describe('submitUrl', () => {
  it('records a TikTok URL with only the manual adapter configured; no metrics are invented', async () => {
    const result = await submitUrl(
      testDeps(db, [manual()], clock.now),
      'https://www.tiktok.com/@fixture.creator/video/7412345678901234567?is_from_webapp=1',
    );
    expect(result.video).toMatchObject({
      platform: 'tiktok',
      platformVideoId: '7412345678901234567',
      canonicalUrl: 'https://www.tiktok.com/@fixture.creator/video/7412345678901234567',
      title: 'when the cat hears the treat bag #funny #cat',
      availability: 'available',
    });
    expect(result.enrichment.status).toBe('no_adapter');
    const [sighting] = await all.sightings();
    expect(sighting).toMatchObject({ source: 'manual-url', platform: 'tiktok' });
    const [video] = await all.videos();
    expect(video).toMatchObject({
      creatorHandle: 'fixture.creator',
      creatorDisplayName: 'Fixture Creator',
      creatorId: null,
    });
    expect(await all.snapshots()).toEqual([]);
  });

  it('enriches a YouTube URL through the YouTube adapter when it is configured', async () => {
    const result = await submitUrl(
      testDeps(db, [manual(), youtube()], clock.now),
      'https://youtu.be/vdFixture01?si=x',
    );
    expect(result.enrichment).toEqual({ status: 'enriched', adapterId: 'youtube', snapshot: true });
    expect(result.video).toMatchObject({
      platform: 'youtube',
      title: 'Cat discovers the vacuum cleaner',
      availability: 'available',
    });
    expect((await all.sightings()).map((s) => s.source)).toEqual(['manual-url']);
    expect((await all.snapshots()).map((s) => s.source)).toEqual(['youtube']);
  });

  it('submitting the same URL twice keeps one video', async () => {
    const deps = testDeps(db, [manual()], clock.now);
    await submitUrl(deps, 'https://clips.twitch.tv/SomeClip-abc');
    clock.advance(HOUR);
    await submitUrl(deps, 'https://www.twitch.tv/chan/clip/SomeClip-abc');
    expect(await all.videos()).toHaveLength(1);
    expect(await all.sightings()).toHaveLength(2);
  });

  it('rejects unsupported URLs before writing anything', async () => {
    const deps = testDeps(db, [manual()], clock.now);
    for (const url of [
      'https://vimeo.com/123',
      'https://www.tiktok.com/@x/photo/7412345678901234567',
      'nonsense',
    ]) {
      await expect(submitUrl(deps, url)).rejects.toBeInstanceOf(UnsupportedUrlError);
    }
    expect(await db.select().from(schema.discoveryRuns)).toEqual([]);
  });
});

describe('submitUrl with a TikTok short link', () => {
  it('stores the expanded canonical video; the same video by full URL is not duplicated', async () => {
    const fetch = createFakeFetch([
      {
        match: (u) => u.href === 'https://www.tiktok.com/t/ZTshort1/',
        responses: [
          {
            status: 301,
            body: '',
            headers: {
              location: 'https://www.tiktok.com/@fixture.creator/video/7412345678901234567?_r=1',
            },
          },
        ],
      },
      route('/oembed', { body: oembed }),
    ]);
    const deps = testDeps(db, [createManualUrlAdapter({ fetch })], clock.now);
    const viaShort = await submitUrl(deps, 'https://www.tiktok.com/t/ZTshort1/');
    expect(viaShort.video).toMatchObject({
      platform: 'tiktok',
      platformVideoId: '7412345678901234567',
    });
    clock.advance(HOUR);
    await submitUrl(deps, 'https://www.tiktok.com/@fixture.creator/video/7412345678901234567');
    expect(await all.videos()).toHaveLength(1);
    const [first] = await all.sightings();
    expect(first?.sighting.context).toMatchObject({
      expandedFrom: 'https://www.tiktok.com/t/ZTshort1/',
    });
  });

  it('reports an unresolvable short link without storing a video', async () => {
    const fetch = createFakeFetch([
      {
        match: (u) => u.hostname === 'vm.tiktok.com',
        responses: [{ status: 302, body: '', headers: { location: 'https://www.tiktok.com/' } }],
      },
    ]);
    const deps = testDeps(db, [createManualUrlAdapter({ fetch })], clock.now);
    await expect(submitUrl(deps, 'https://vm.tiktok.com/ZMbad/')).rejects.toThrow(/not_a_video/);
    expect(await all.videos()).toEqual([]);
  });
});

describe('runDiscovery (Twitch)', () => {
  it('stores clips with view snapshots', async () => {
    const twitch = createTwitchAdapter({
      clientId: 'c',
      clientSecret: 's',
      fetch: createFakeFetch([
        route('/oauth2/token', { body: twitchToken }),
        route('/helix/clips', { body: { ...clips, pagination: {} } }),
      ]),
    });
    const run = await runDiscovery(testDeps(db, [twitch], clock.now), {
      adapterId: 'twitch',
      kind: 'trending',
      params: { gameId: '509658', lookbackHours: 24 },
      limit: 20,
    });
    expect(run).toMatchObject({ status: 'succeeded', itemsNew: 2 });
    expect((await all.snapshots()).map((s) => s.snap.views)).toEqual([18_234, 950]);
  });
});
