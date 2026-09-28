import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asc, desc, eq } from 'drizzle-orm';
import { createFakeFetch, route } from '@vd/adapter-contract/testing';
import { createBlueskyAdapter } from '@vd/adapter-bluesky';
import { createManualUrlAdapter } from '@vd/adapter-manual-url';
import { createYouTubeAdapter } from '@vd/adapter-youtube';
import { schema, type AnyDatabase } from '@vd/db';
import mostPopular from '../../adapters/youtube/fixtures/videos-list-mostPopular.json' with { type: 'json' };
import searchPosts from '../../adapters/bluesky/fixtures/searchPosts.json' with { type: 'json' };
import { runDiscovery } from './ingest.ts';
import { rescore, scoreVideo, selectForScoring } from './score.ts';
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

const youtube = () =>
  createYouTubeAdapter({
    apiKey: 'k',
    fetch: createFakeFetch([
      route('/youtube/v3/videos', { body: { ...mostPopular, nextPageToken: undefined } }),
    ]),
  });
const bluesky = () =>
  createBlueskyAdapter({
    fetch: createFakeFetch([
      route('/xrpc/app.bsky.feed.searchPosts', { body: { ...searchPosts, cursor: undefined } }),
    ]),
  });
const manual = () => createManualUrlAdapter({ fetch: createFakeFetch([]) });
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
const scoresOf = async (id: string) =>
  db
    .select()
    .from(schema.scores)
    .where(eq(schema.scores.videoId, id))
    .orderBy(asc(schema.scores.computedAt));

describe('manual submissions are provenance, not propagation (end to end)', () => {
  it('ten manual submissions keep their sightings but cannot change the virality score', async () => {
    const all = testDeps(db, [youtube(), bluesky(), manual()], clock.now);
    await runDiscovery(all, ytTrending);
    await runDiscovery(all, {
      adapterId: 'bluesky',
      kind: 'search',
      params: { q: 'funny' },
      limit: 50,
    });
    const cat = await videoId('vdFixture01');
    const before = await scoreVideo(all, cat);

    // Submissions through a registry without YouTube: no enrichment snapshot, so the
    // only new evidence is the manual sightings themselves.
    const submitOnly = testDeps(db, [manual()], clock.now);
    for (let i = 0; i < 10; i++) {
      clock.advance(60_000);
      await submitUrl(submitOnly, 'https://youtu.be/vdFixture01');
    }
    const manualSightings = await db
      .select()
      .from(schema.sightings)
      .innerJoin(schema.sources, eq(schema.sources.id, schema.sightings.sourceId))
      .where(eq(schema.sources.name, 'manual-url'));
    expect(manualSightings).toHaveLength(10);

    const after = await scoreVideo(all, cat, { asOf: clock.now() });
    const beforeAtSameTime = await scoreVideo(all, cat, { asOf: clock.now(), force: true });
    expect(after.result.score).toBe(beforeAtSameTime.result.score);
    expect(after.result.components.crossSource).toEqual(
      beforeAtSameTime.result.components.crossSource,
    );
    expect(after.result.components.sourcePropagation).toEqual(
      before.result.components.sourcePropagation,
    );
    expect(after.result.observations).toEqual({
      publicPropagation: [
        { source: 'bluesky', observations: 1 },
        { source: 'youtube', observations: 1 },
      ],
      nonPropagation: [{ source: 'manual-url', observations: 1 }],
    });
    expect(after.result.reasonCodes).toContain('NON_PROPAGATION_OBSERVATIONS');
    const [stored] = await db
      .select()
      .from(schema.scores)
      .where(eq(schema.scores.videoId, cat))
      .orderBy(desc(schema.scores.computedAt))
      .limit(1);
    expect((stored!.components['_meta'] as { observations: unknown }).observations).toEqual(
      after.result.observations,
    );
  });

  it('an unknown adapter is treated as provenance (never inflates virality)', async () => {
    const deps = testDeps(db, [youtube()], clock.now);
    await runDiscovery(deps, ytTrending);
    const cat = await videoId('vdFixture01');
    const [ghost] = await db
      .insert(schema.sources)
      .values({ name: 'ghost', adapterId: 'removed-adapter', enabled: true })
      .returning();
    await db
      .insert(schema.sightings)
      .values({ videoId: cat, sourceId: ghost!.id, observationKey: 'x', seenAt: clock.now() });
    const r = await scoreVideo(deps, cat);
    expect(r.result.observations.nonPropagation).toEqual([{ source: 'ghost', observations: 1 }]);
    expect(r.result.components.crossSource).toMatchObject({ details: { distinctSources: 1 } });
  });
});

describe('time-based score staleness', () => {
  it('rescored when due, lower with age, idempotent before due, and eventually aged out', async () => {
    const deps = testDeps(db, [youtube()], clock.now);
    await runDiscovery(deps, ytTrending);
    const cat = await videoId('vdFixture01');

    expect((await rescore(deps, { scope: { kind: 'stale' }, limit: 100 })).created).toBe(2);
    // Repeated scheduler runs before the next due time do nothing.
    expect(await selectForScoring(deps, { scope: { kind: 'stale' }, limit: 100 })).toEqual([]);
    clock.advance(HOUR);
    expect((await rescore(deps, { scope: { kind: 'stale' }, limit: 100 })).considered).toBe(0);
    expect((await scoreVideo(deps, cat)).status).toBe('unchanged');

    const [first] = await scoresOf(cat);
    const due = first!.nextRescoreAt!;
    expect(due.getTime()).toBeGreaterThan(clock.now().getTime());

    // Reach the due time with NO new evidence: eligible again, and the score has decayed.
    clock.advance(due.getTime() - clock.now().getTime());
    expect(
      await selectForScoring(deps, { scope: { kind: 'stale' }, platform: 'youtube', limit: 100 }),
    ).toContain(cat);
    await rescore(deps, { scope: { kind: 'stale' }, limit: 100 });
    const [a, b] = await scoresOf(cat);
    expect(b!.inputsHash).toBe(a!.inputsHash); // same evidence…
    expect(b!.value!).toBeLessThan(a!.value!); // …but older, so lower
    expect((b!.components['freshness'] as { value: number }).value).toBeLessThan(
      (a!.components['freshness'] as { value: number }).value,
    );
    expect((await rescore(deps, { scope: { kind: 'stale' }, limit: 100 })).considered).toBe(0);

    // Keep advancing to each due time: rescoring is bounded and stops (ages out).
    let passes = 0;
    for (;;) {
      const next = (await scoresOf(cat)).at(-1)!.nextRescoreAt;
      if (!next) break;
      clock.advance(Math.max(0, next.getTime() - clock.now().getTime()));
      await rescore(deps, { scope: { kind: 'videos', videoIds: [cat] }, limit: 1 });
      passes += 1;
      expect(passes).toBeLessThan(60);
    }
    clock.advance(30 * 24 * HOUR);
    expect(await selectForScoring(deps, { scope: { kind: 'stale' }, limit: 100 })).not.toContain(
      cat,
    );
    const last = (await scoresOf(cat)).at(-1)!;
    expect(last.nextRescoreAt).toBeNull();
    expect((last.components['freshness'] as { value: number }).value).toBeLessThanOrEqual(0.0501);
  });

  it('insufficient-evidence scores are never rescheduled by time alone', async () => {
    const deps = testDeps(db, [bluesky()], clock.now);
    await runDiscovery(deps, {
      adapterId: 'bluesky',
      kind: 'search',
      params: { q: 'funny' },
      limit: 50,
    });
    const tiktok = await videoId('7412345678901234567');
    await scoreVideo(deps, tiktok);
    const [row] = await scoresOf(tiktok);
    expect(row).toMatchObject({ state: 'insufficient_evidence', value: null, nextRescoreAt: null });
    clock.advance(7 * 24 * HOUR);
    expect(
      await selectForScoring(deps, { scope: { kind: 'stale' }, platform: 'tiktok', limit: 100 }),
    ).toEqual([]);
  });
});
