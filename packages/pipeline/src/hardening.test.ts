/**
 * Regressions from the first live pilot (2026-10-03): source moderation labels
 * are stored and kept current, and api_usage counts metered requests per bucket.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createFakeFetch, route } from '@vd/adapter-contract/testing';
import { createBlueskyAdapter } from '@vd/adapter-bluesky';
import { createYouTubeAdapter } from '@vd/adapter-youtube';
import { schema, type AnyDatabase } from '@vd/db';
import labelled from '../../adapters/bluesky/fixtures/searchPosts-labelled.json' with { type: 'json' };
import mostPopular from '../../adapters/youtube/fixtures/videos-list-mostPopular.json' with { type: 'json' };
import batchStats from '../../adapters/youtube/fixtures/batchGetStats.json' with { type: 'json' };
import searchList from '../../adapters/youtube/fixtures/search-list.json' with { type: 'json' };
import { runDiscovery } from './ingest.ts';
import { refreshMetrics } from './refresh.ts';
import { createTestDb, testClock, testDeps } from './testing.ts';

let db: AnyDatabase;
let close: () => Promise<void>;
let clock: ReturnType<typeof testClock>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock = testClock('2026-10-03T02:00:00Z');
});
afterEach(async () => {
  await close();
});

const [modPost, , , , unlabelledPost] = labelled.posts;
const labelsOf = async (platformVideoId: string) =>
  (
    await db
      .select({ labels: schema.videos.sourceModerationLabels })
      .from(schema.videos)
      .where(eq(schema.videos.platformVideoId, platformVideoId))
  )[0]?.labels;

describe('source moderation labels in the pipeline', () => {
  it('stores platform labels on native videos and none on linked references', async () => {
    const bluesky = createBlueskyAdapter({
      fetch: createFakeFetch([route('/xrpc/app.bsky.feed.searchPosts', { body: labelled })]),
    });
    await runDiscovery(testDeps(db, [bluesky], clock.now), {
      adapterId: 'bluesky',
      kind: 'search',
      params: { q: 'x' },
      limit: 50,
    });
    expect(await labelsOf(modPost!.uri)).toEqual([
      {
        value: 'porn',
        labeler: 'did:plc:ar7c4by46qjdydhdevvrndac',
        scope: 'content',
        selfApplied: false,
        explicit: true,
      },
    ]);
    expect(await labelsOf(unlabelledPost!.uri)).toEqual([]);
    // The labelled post's link to YouTube does not label the YouTube video.
    expect(await labelsOf('fixtureLbl1')).toBeNull();
  });

  it('picks up labels applied after discovery, and retractions, on refresh', async () => {
    const uri = unlabelledPost!.uri;
    const laterLabel = {
      src: 'did:plc:ar7c4by46qjdydhdevvrndac',
      uri,
      val: 'porn',
      cts: '2026-10-03T03:00:00Z',
    };
    // getPosts answers in order: labelled an hour later, then the label retracted.
    const bluesky = createBlueskyAdapter({
      fetch: createFakeFetch([
        route('/xrpc/app.bsky.feed.searchPosts', { body: { posts: [unlabelledPost] } }),
        route('/xrpc/app.bsky.feed.getPosts', [
          { body: { posts: [{ ...unlabelledPost, labels: [laterLabel] }] } },
          { body: { posts: [unlabelledPost] } },
        ]),
      ]),
    });
    const deps = testDeps(db, [bluesky], clock.now);
    await runDiscovery(deps, {
      adapterId: 'bluesky',
      kind: 'search',
      params: { q: 'x' },
      limit: 5,
    });
    expect(await labelsOf(uri)).toEqual([]);

    clock.advance(3_600_000);
    await refreshMetrics(deps, { platform: 'bluesky', limit: 10 });
    expect((await labelsOf(uri))?.map((l) => [l.value, l.explicit])).toEqual([['porn', true]]);

    clock.advance(3_600_000);
    await refreshMetrics(deps, { platform: 'bluesky', limit: 10 });
    expect(await labelsOf(uri)).toEqual([]);
  });
});

describe('api_usage request counts', () => {
  it('counts metered requests per bucket, keeping YouTube buckets separate', async () => {
    const youtube = createYouTubeAdapter({
      apiKey: 'k',
      fetch: createFakeFetch([
        route('/youtube/v3/videos:batchGetStats', { body: batchStats }),
        route('/youtube/v3/search', { body: { ...searchList, nextPageToken: undefined } }),
        route('/youtube/v3/videos', { body: { items: [mostPopular.items[0]] } }),
      ]),
    });
    const deps = testDeps(db, [youtube], clock.now);
    await runDiscovery(deps, {
      adapterId: 'youtube',
      kind: 'search',
      params: { q: 'funny' },
      limit: 25,
    });
    await runDiscovery(deps, {
      adapterId: 'youtube',
      kind: 'search',
      params: { q: 'fails' },
      limit: 25,
    });
    await refreshMetrics(deps, { platform: 'youtube', limit: 10 });

    const usage = await db
      .select({
        bucket: schema.apiUsage.quotaBucket,
        units: schema.apiUsage.unitsUsed,
        requests: schema.apiUsage.requestCount,
      })
      .from(schema.apiUsage)
      .orderBy(schema.apiUsage.quotaBucket);
    expect(usage).toEqual([
      { bucket: 'default', units: 2, requests: 2 },
      { bucket: 'search.list', units: 2, requests: 2 },
      { bucket: 'videos.batchGetStats', units: 1, requests: 1 },
    ]);
  });
});
