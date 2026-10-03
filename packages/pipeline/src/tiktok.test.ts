/**
 * Direct TikTok discovery through a provider-neutral adapter (Bright Data fixtures,
 * no network): identity, sightings, snapshots, reference enrichment, refresh, and
 * credential hygiene end to end through the real pipeline.
 */
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { createFakeFetch, route } from '@vd/adapter-contract/testing';
import { createBlueskyAdapter } from '@vd/adapter-bluesky';
import { createBrightDataProvider, createTikTokAdapter } from '@vd/adapter-tiktok';
import { schema, type AnyDatabase } from '@vd/db';
import searchPosts from '../../adapters/bluesky/fixtures/searchPosts.json' with { type: 'json' };
import snapshot from '../../adapters/tiktok/fixtures/brightdata-snapshot-funny.json' with { type: 'json' };
import { runDiscovery } from './ingest.ts';
import { refreshMetrics } from './refresh.ts';
import { createTestDb, testClock, testDeps } from './testing.ts';

const TOKEN = 'bd-pipeline-token-NEVER-LOG-77aa';
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

/** Every collection job (search or lookup) answers with `records`. */
const brightdataFetch = (records: unknown) =>
  createFakeFetch([
    route('/datasets/v3/trigger', { body: { snapshot_id: 's_pipe' } }),
    route('/datasets/v3/progress/s_pipe', { body: { status: 'ready' } }),
    route('/datasets/v3/snapshot/s_pipe', { body: records }),
  ]);
const tiktok = (records: unknown = snapshot, fetch = brightdataFetch(records)) =>
  createTikTokAdapter({
    provider: createBrightDataProvider({ token: TOKEN, fetch, sleep: () => Promise.resolve() }),
  });
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

describe('direct TikTok discovery', () => {
  it('C: one canonical video per TikTok id, one sighting per query that found it', async () => {
    const deps = testDeps(db, [tiktok()], clock.now);
    const first = await runDiscovery(deps, search('funny'));
    clock.advance(60_000);
    const second = await runDiscovery(deps, search('funny animals'));

    // 2 videos; the carousel, the provider error and the malformed record are quarantined.
    expect(first).toMatchObject({ status: 'succeeded', itemsFound: 5, itemsNew: 2 });
    expect(first.stats).toMatchObject({ ingested: 2, invalid: 3 });
    expect(second).toMatchObject({ itemsNew: 0, stats: { videosUpdated: 2 } });
    const videos = await videosOf();
    expect(videos.map((v) => [v.platform, v.platformVideoId]).sort()).toEqual([
      ['tiktok', '7550000000000000001'],
      ['tiktok', '7550000000000000002'],
    ]);
    const cat = videos.find((v) => v.platformVideoId === '7550000000000000001')!;
    expect((await sightingsOf(cat.id)).map((s) => s.key).sort()).toEqual([
      'search:funny',
      'search:funny animals',
    ]);
    // Publish time/duration/thumbnail/creator are on the canonical row.
    expect(cat).toMatchObject({
      canonicalUrl: 'https://www.tiktok.com/@fixture.pets/video/7550000000000000001',
      durationMs: 18_000,
      publishedAt: new Date('2026-10-03T08:00:00Z'),
      thumbnailUrl: 'https://p16-sign.tiktokcdn-us.com/fixture-cover-1.jpeg',
      creatorHandle: 'fixture.pets',
    });
    // L: the stored raw payload is the neutral, allowlisted shape only.
    const raw = JSON.stringify(cat.rawPayload);
    // Other users' comment TEXT must not be stored (the neutral `comments` COUNT is expected).
    for (const forbidden of [
      'video_url',
      '.mp4',
      'PRIVATE-ISH BIO',
      'DO-NOT-STORE',
      'someone.else',
    ])
      expect(raw).not.toContain(forbidden);
  });

  it('D/E: writes views/likes/comments/shares snapshots; unreported metrics stay NULL with a reason', async () => {
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

  it('records request and record usage per bucket', async () => {
    await runDiscovery(testDeps(db, [tiktok()], clock.now), search('funny'));
    const usage = await db
      .select({
        bucket: schema.apiUsage.quotaBucket,
        units: schema.apiUsage.unitsUsed,
        requests: schema.apiUsage.requestCount,
      })
      .from(schema.apiUsage)
      .orderBy(schema.apiUsage.quotaBucket);
    expect(usage).toEqual([
      // 3 delivered post records are billed (incl. the carousel the pipeline quarantines).
      { bucket: 'records', units: 3, requests: 1 },
      { bucket: 'requests', units: 3, requests: 3 },
    ]);
  });

  it('J: a TikTok link found on Bluesky is enriched by the TikTok provider, keeping the Bluesky sighting', async () => {
    const bluesky = createBlueskyAdapter({
      fetch: createFakeFetch([
        route('/xrpc/app.bsky.feed.searchPosts', { body: { ...searchPosts, cursor: undefined } }),
      ]),
      expandShortLinks: false,
    });
    const lookup = [
      {
        url: 'https://www.tiktok.com/@fixture.creator/video/7412345678901234567',
        post_id: '7412345678901234567',
        description: 'when the cat hears the treat bag #funny #cat',
        create_time: '2026-10-02T20:00:00Z',
        play_count: 900_000,
        digg_count: 80_000,
        comment_count: 1_200,
        num_share_count: 4_000,
        video_duration: 21,
        profile_username: 'fixture.creator',
        profile_id: '6900000000000000077',
        preview_image: 'https://p16-sign.tiktokcdn-us.com/fixture-cover-ref.jpeg',
      },
    ];
    const fetch = brightdataFetch(lookup);
    const deps = testDeps(db, [bluesky, tiktok(lookup, fetch)], clock.now);
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
    expect(ref).toMatchObject({
      platform: 'tiktok',
      durationMs: 21_000,
      publishedAt: new Date('2026-10-02T20:00:00Z'),
      thumbnailUrl: 'https://p16-sign.tiktokcdn-us.com/fixture-cover-ref.jpeg',
      creatorHandle: 'fixture.creator',
      availability: 'available',
    });
    expect((await sightingsOf(ref.id)).map((s) => s.source)).toEqual(['bluesky']);
    const [snap] = await snapshotsOf(ref.id);
    expect(snap).toMatchObject({ views: 900_000, likes: 80_000 });
    // All references of the run went out as ONE provider lookup job.
    expect(fetch.requests.filter((r) => r.url.pathname.endsWith('/trigger'))).toHaveLength(1);
  });

  it('K: refreshes TikTok metrics through the provider (batched) into new snapshots', async () => {
    const deps = testDeps(db, [tiktok()], clock.now);
    await runDiscovery(deps, search('funny'));
    clock.advance(2 * 3_600_000);
    const later = snapshot.map((r) =>
      'play_count' in r && r.post_id === '7550000000000000001'
        ? { ...r, play_count: 4_100_000 }
        : r,
    );
    const fetch = brightdataFetch(later);
    const summary = await refreshMetrics(testDeps(db, [tiktok(later, fetch)], clock.now), {
      platform: 'tiktok',
      limit: 10,
    });
    expect(summary).toMatchObject({ requested: 2, snapshotsCreated: 2, error: null });
    expect(fetch.requests.filter((r) => r.url.pathname.endsWith('/trigger'))).toHaveLength(1);
    const cat = (await videosOf()).find((v) => v.platformVideoId === '7550000000000000001')!;
    expect((await snapshotsOf(cat.id)).map((s) => s.views).sort()).toEqual([3_200_000, 4_100_000]);
  });

  it('M: a provider failure is recorded on the run and in logs without the token', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const failing = createFakeFetch([
      route('/datasets/v3/trigger', { status: 401, body: { error: 'Unauthorized' } }),
    ]);
    const deps = { ...testDeps(db, [tiktok(snapshot, failing)], clock.now), logger: pino(sink) };
    const run = await runDiscovery(deps, search('funny'));
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/brightdata: HTTP 401 .*check BRIGHTDATA_API_TOKEN/);
    expect(lines.join('')).toContain('discovery run did not complete');
    const everything =
      lines.join('') +
      JSON.stringify(run) +
      JSON.stringify(await db.select().from(schema.discoveryRuns));
    expect(everything).not.toContain(TOKEN);
  });
});
