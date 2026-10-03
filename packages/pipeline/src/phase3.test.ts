import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { createFakeFetch, route } from '@vd/adapter-contract/testing';
import { createBlueskyAdapter } from '@vd/adapter-bluesky';
import { createManualUrlAdapter } from '@vd/adapter-manual-url';
import { createYouTubeAdapter } from '@vd/adapter-youtube';
import { schema, type AnyDatabase } from '@vd/db';
import mostPopular from '../../adapters/youtube/fixtures/videos-list-mostPopular.json' with { type: 'json' };
import batchStats from '../../adapters/youtube/fixtures/batchGetStats.json' with { type: 'json' };
import searchList from '../../adapters/youtube/fixtures/search-list.json' with { type: 'json' };
import searchPosts from '../../adapters/bluesky/fixtures/searchPosts.json' with { type: 'json' };
import oembed from '../../adapters/manual-url/fixtures/tiktok-oembed.json' with { type: 'json' };
import { runDiscovery } from './ingest.ts';
import { DEFAULT_REFRESH_POLICY, ladderStatus, parseLadder, refreshDue } from './refresh-policy.ts';
import { rescore, scoreVideo, selectForScoring } from './score.ts';
import { dueQueries, runDueQueries } from './schedule.ts';
import { submitUrl } from './submit.ts';
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

const chartPage = { ...mostPopular, nextPageToken: undefined };
const youtubeFetch = () =>
  createFakeFetch([
    route('/youtube/v3/videos:batchGetStats', { body: batchStats }),
    route('/youtube/v3/search', { body: { ...searchList, nextPageToken: undefined } }),
    route('/youtube/v3/videos', { body: { items: [mostPopular.items[0]] } }, (u) =>
      u.searchParams.has('id'),
    ),
    route('/youtube/v3/videos', { body: chartPage }),
  ]);
const youtube = (fetch = youtubeFetch()) => createYouTubeAdapter({ apiKey: 'k', fetch });
const bluesky = () =>
  createBlueskyAdapter({
    fetch: createFakeFetch([
      route('/xrpc/app.bsky.feed.searchPosts', { body: { ...searchPosts, cursor: undefined } }),
    ]),
  });
const ytTrending = {
  adapterId: 'youtube',
  kind: 'trending' as const,
  params: { regionCode: 'US' },
  limit: 50,
};
const videoId = async (platformVideoId: string) =>
  (
    await db
      .select({ id: schema.videos.id })
      .from(schema.videos)
      .where(eq(schema.videos.platformVideoId, platformVideoId))
  )[0]!.id;
const snapshotsOf = async (id: string) =>
  db
    .select()
    .from(schema.metricSnapshots)
    .where(eq(schema.metricSnapshots.videoId, id))
    .orderBy(asc(schema.metricSnapshots.capturedAt));

describe('YouTube search quota', () => {
  it('limits search.list by the manifest default even when the source row predates the bucket', async () => {
    const fetch = youtubeFetch();
    const deps = testDeps(db, [youtube(fetch)], clock.now);
    // A Phase-2-era source row: budgets without "search.list".
    await db.insert(schema.sources).values({
      name: 'youtube',
      adapterId: 'youtube',
      enabled: true,
      dailyQuotaBudgets: { default: 10_000 },
    });
    const [source] = await db.select().from(schema.sources);
    await db.insert(schema.apiUsage).values({
      sourceId: source!.id,
      usageDate: '2026-09-28',
      quotaBucket: 'search.list',
      unitsUsed: 100,
    });

    const run = await runDiscovery(deps, {
      adapterId: 'youtube',
      kind: 'search',
      params: { q: 'funny' },
      limit: 25,
    });
    expect(run.status).toBe('partial');
    expect(run.error).toMatch(/budget for bucket "search.list" is exhausted/);
    expect(fetch.requests.filter((r) => r.url.pathname.endsWith('/search'))).toHaveLength(0);
  });

  it('records search results as sightings keyed by the query', async () => {
    const run = await runDiscovery(testDeps(db, [youtube()], clock.now), {
      adapterId: 'youtube',
      kind: 'search',
      params: { q: 'funny animals', publishedWithinHours: 24 },
      limit: 25,
    });
    expect(run).toMatchObject({
      status: 'succeeded',
      itemsNew: 1,
      stats: { quotaUsed: { 'search.list': 1, default: 1 } },
    });
    const [s] = await db.select().from(schema.sightings);
    expect(s?.observationKey).toBe('search:funny animals:-');
  });
});

describe('refresh ladder', () => {
  const t0 = new Date('2026-09-28T12:00:00Z');
  const at = (h: number) => new Date(t0.getTime() + h * HOUR);

  it('decides per step, with tolerance, and ages out', () => {
    const p = DEFAULT_REFRESH_POLICY; // 2h, 8h, 24h, 72h; tolerance 0.2; grace 6h
    expect(ladderStatus(t0, [t0], at(1), p)).toMatchObject({ due: false, reason: 'waiting' });
    expect(ladderStatus(t0, [t0], at(2), p)).toMatchObject({ due: true, step: 1 });
    expect(ladderStatus(t0, [t0, at(1.7)], at(2.5), p)).toMatchObject({
      due: false,
      reason: 'step_satisfied',
    });
    expect(ladderStatus(t0, [t0, at(2)], at(9), p)).toMatchObject({ due: true, step: 2 });
    // Missed steps collapse into the latest one: one refresh, not a backlog.
    expect(ladderStatus(t0, [t0], at(30), p)).toMatchObject({ due: true, step: 3 });
    expect(ladderStatus(t0, [t0], at(72 + 7), p)).toMatchObject({ due: false, reason: 'aged_out' });
  });

  it('parses human ladders', () => {
    expect(parseLadder('2h, 8h,24h,3d')).toEqual([120, 480, 1_440, 4_320]);
    expect(parseLadder('90m,150')).toEqual([90, 150]);
    expect(() => parseLadder('soon')).toThrow(/invalid ladder step/);
  });

  it('refreshes only due videos, in one bulk call, and stops when satisfied', async () => {
    const fetch = youtubeFetch();
    const deps = testDeps(db, [youtube(fetch)], clock.now);
    await runDiscovery(deps, ytTrending);
    const stats = () => fetch.requests.filter((r) => r.url.pathname.endsWith(':batchGetStats'));

    clock.advance(1 * HOUR);
    expect(await refreshDue(deps, { platform: 'youtube', limit: 100 })).toMatchObject({
      due: 0,
      requested: 0,
    });

    clock.advance(1 * HOUR);
    const first = await refreshDue(deps, { platform: 'youtube', limit: 100 });
    expect(first).toMatchObject({ considered: 2, due: 2, requested: 2, snapshotsCreated: 2 });
    expect(stats()).toHaveLength(1);

    expect(await refreshDue(deps, { platform: 'youtube', limit: 100 })).toMatchObject({ due: 0 });

    clock.advance(6 * HOUR);
    expect(await refreshDue(deps, { platform: 'youtube', limit: 100 })).toMatchObject({ due: 2 });

    clock.advance(5 * 24 * HOUR);
    expect(await refreshDue(deps, { platform: 'youtube', limit: 100 })).toMatchObject({
      due: 0,
      agedOut: 0,
      considered: 0,
    });
    expect((await snapshotsOf(await videoId('vdFixture01'))).length).toBe(3);
  });

  it('reads the ladder from the refreshing source’s config', async () => {
    const deps = testDeps(db, [youtube()], clock.now);
    await runDiscovery(deps, ytTrending);
    await db
      .update(schema.sources)
      .set({ config: { refreshPolicy: { ladderMinutes: [30] } } })
      .where(eq(schema.sources.name, 'youtube'));
    clock.advance(0.5 * HOUR);
    const r = await refreshDue(deps, { platform: 'youtube', limit: 100 });
    expect(r.policy.ladderMinutes).toEqual([30]);
    expect(r.due).toBe(2);
  });

  it('gives Bluesky-linked YouTube videos their first canonical snapshot', async () => {
    const deps = testDeps(db, [youtube(), bluesky()], clock.now);
    await runDiscovery(deps, {
      adapterId: 'bluesky',
      kind: 'search',
      params: { q: 'funny' },
      limit: 50,
      // The ladder path for references that were not enriched at discovery time.
      enrichReferences: false,
    });
    const cat = await videoId('vdFixture01');
    expect(await snapshotsOf(cat)).toHaveLength(0);
    clock.advance(2 * HOUR);
    await refreshDue(deps, { platform: 'youtube', limit: 100 });
    expect((await snapshotsOf(cat)).map((s) => s.views)).toEqual([110_000]);
  });
});

describe('scoring lifecycle', () => {
  it('provisional after one snapshot, scored after a refresh; rescoring is idempotent', async () => {
    const deps = testDeps(db, [youtube()], clock.now);
    await runDiscovery(deps, ytTrending);
    const cat = await videoId('vdFixture01');

    const first = await scoreVideo(deps, cat);
    expect(first).toMatchObject({ status: 'created', result: { state: 'provisional' } });
    expect(first.result.components.velocity).toMatchObject({
      available: false,
      reason: 'needs 2 snapshots; have 1',
    });

    // Same evidence → no new row, identical result.
    const again = await scoreVideo(deps, cat);
    expect(again.status).toBe('unchanged');
    expect(again.result).toEqual(first.result);

    clock.advance(2 * HOUR);
    await refreshDue(deps, { platform: 'youtube', limit: 100 });
    // Only videos with new evidence are selected.
    expect((await selectForScoring(deps, { scope: { kind: 'stale' }, limit: 100 })).length).toBe(2);
    const summary = await rescore(deps, { scope: { kind: 'stale' }, limit: 100 });
    expect(summary).toMatchObject({ considered: 2, created: 2, byState: { scored: 2 } });
    expect(await selectForScoring(deps, { scope: { kind: 'stale' }, limit: 100 })).toEqual([]);

    const [latest] = await db
      .select()
      .from(schema.scores)
      .where(eq(schema.scores.videoId, cat))
      .orderBy(asc(schema.scores.computedAt));
    expect(latest).toMatchObject({ algorithmVersion: 'breakout-v1.1', state: 'provisional' });
    const rows = await db
      .select()
      .from(schema.scores)
      .where(eq(schema.scores.videoId, cat))
      .orderBy(asc(schema.scores.computedAt));
    expect(rows.map((r) => r.state)).toEqual(['provisional', 'scored']);
    expect(rows[1]).toMatchObject({ computedAt: new Date('2026-09-28T14:00:00Z') });
    expect(rows[1]!.value).toBeGreaterThan(0);
    expect(rows[1]!.components['velocity']).toMatchObject({
      available: true,
      details: { metric: 'views', from: { value: 50_000 }, to: { value: 110_000 }, hours: 2 },
    });
    expect(rows[1]!.reasonCodes).toEqual(expect.arrayContaining(['CREATOR_BASELINE_UNAVAILABLE']));
  });

  it('a manual TikTok submission gets insufficient_evidence and a NULL value', async () => {
    const deps = testDeps(
      db,
      [createManualUrlAdapter({ fetch: createFakeFetch([route('/oembed', { body: oembed })]) })],
      clock.now,
    );
    const { video } = await submitUrl(
      deps,
      'https://www.tiktok.com/@fixture.creator/video/7412345678901234567',
    );
    const r = await scoreVideo(deps, video.id);
    expect(r.result).toMatchObject({ state: 'insufficient_evidence', score: null });
    const [row] = await db.select().from(schema.scores);
    expect(row).toMatchObject({ value: null, state: 'insufficient_evidence', confidence: 0 });
  });

  it('keeps Bluesky post engagement out of canonical components', async () => {
    const deps = testDeps(db, [youtube(), bluesky()], clock.now);
    await runDiscovery(deps, ytTrending);
    await runDiscovery(deps, {
      adapterId: 'bluesky',
      kind: 'search',
      params: { q: 'funny' },
      limit: 50,
    });
    const cat = await scoreVideo(deps, await videoId('vdFixture01'));
    expect(cat.result.components.crossSource).toMatchObject({
      available: true,
      details: { distinctSources: 2 },
    });
    expect(cat.result.components.sourcePropagation).toMatchObject({
      available: true,
      basis: 'source_propagation',
      details: { items: 1, likes: 87, reposts: 12, replies: 3, quotes: 1 },
    });
    expect(cat.result.components.engagement).toMatchObject({
      basis: 'canonical',
      details: { views: 50_000 },
    });

    const native = await scoreVideo(
      deps,
      await videoId('at://did:plc:fixtureauthor000000000002/app.bsky.feed.post/3fixturepost2'),
    );
    expect(native.result.growthMetric).toBe('likes');
    expect(native.result.components.sourcePropagation).toMatchObject({ available: false });
  });

  it('a new cross-source sighting makes a video stale again', async () => {
    const deps = testDeps(db, [youtube(), bluesky()], clock.now);
    await runDiscovery(deps, ytTrending);
    await rescore(deps, { scope: { kind: 'stale' }, limit: 100 });
    expect(await selectForScoring(deps, { scope: { kind: 'stale' }, limit: 100 })).toEqual([]);
    clock.advance(HOUR);
    await runDiscovery(deps, {
      adapterId: 'bluesky',
      kind: 'search',
      params: { q: 'funny' },
      limit: 50,
    });
    const stale = await selectForScoring(deps, {
      scope: { kind: 'stale' },
      platform: 'youtube',
      limit: 100,
    });
    expect(stale).toEqual([await videoId('vdFixture01')]);
  });

  it('builds the platform population from earlier scores of other videos', async () => {
    const deps = testDeps(db, [youtube()], clock.now);
    await runDiscovery(deps, ytTrending);
    clock.advance(2 * HOUR);
    await refreshDue(deps, { platform: 'youtube', limit: 100 });
    await scoreVideo(deps, await videoId('vdFixture02'));
    const cat = await scoreVideo(deps, await videoId('vdFixture01'));
    expect(cat.result.components.velocity).toMatchObject({
      normalization: 'absolute_fallback',
      details: { populationSize: 1 },
    });
  });
});

describe('scheduled source queries', () => {
  it('runs due queries by cadence, skips unconfigured adapters and disabled queries', async () => {
    const deps = testDeps(db, [youtube()], clock.now);
    const [yt] = await db
      .insert(schema.sources)
      .values({ name: 'yt-funny', adapterId: 'youtube', enabled: true })
      .returning();
    const [tw] = await db
      .insert(schema.sources)
      .values({ name: 'twitch', adapterId: 'twitch', enabled: true })
      .returning();
    await db.insert(schema.sourceQueries).values([
      {
        sourceId: yt!.id,
        kind: 'search',
        params: { q: 'funny animals', publishedWithinHours: 24 },
        cadenceMinutes: 60,
        enabled: true,
      },
      {
        sourceId: yt!.id,
        kind: 'trending',
        params: { regionCode: 'US' },
        cadenceMinutes: 30,
        enabled: false,
      },
      {
        sourceId: yt!.id,
        kind: 'trending',
        params: { regionCode: 'GB' },
        cadenceMinutes: null,
        enabled: true,
      },
      {
        sourceId: tw!.id,
        kind: 'trending',
        params: { gameId: '1' },
        cadenceMinutes: 60,
        enabled: true,
      },
    ]);

    const first = await runDueQueries(deps, { limit: 25 });
    expect(first.runs.map((r) => [r.source, r.status])).toEqual([['yt-funny', 'succeeded']]);
    expect(first.skipped.map((s) => s.reason)).toEqual(['adapter "twitch" is not configured']);
    const [run] = await db.select().from(schema.discoveryRuns);
    expect(run?.trigger).toBe('schedule');

    clock.advance(30 * 60_000);
    expect((await dueQueries(deps)).due).toEqual([]);
    clock.advance(31 * 60_000);
    expect((await dueQueries(deps)).due.map((d) => d.source)).toEqual(['yt-funny']);
  });
});
