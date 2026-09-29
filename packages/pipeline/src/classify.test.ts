import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createFakeFetch, route } from '@vd/adapter-contract/testing';
import { createBlueskyAdapter } from '@vd/adapter-bluesky';
import { createYouTubeAdapter } from '@vd/adapter-youtube';
import {
  createFakeClassifier,
  PROMPT_VERSION,
  TAXONOMY_VERSION,
  type ModelOutput,
} from '@vd/classification';
import { schema, type AnyDatabase } from '@vd/db';
import mostPopular from '../../adapters/youtube/fixtures/videos-list-mostPopular.json' with { type: 'json' };
import searchPosts from '../../adapters/bluesky/fixtures/searchPosts.json' with { type: 'json' };
import {
  DEFAULT_CLASSIFICATION_POLICY,
  buildClassificationInput,
  classifyCluster,
  classifyEligible,
  describeContext,
  latestClassification,
  selectClassificationCandidates,
} from './classify.ts';
import { runDiscovery } from './ingest.ts';
import { scoreVideo } from './score.ts';
import { createTestDb, testClock, testDeps } from './testing.ts';

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

const output: ModelOutput = {
  summary: 'A cat meets a robot vacuum.',
  labels: [
    { label: 'funny', confidence: 0.9 },
    { label: 'animals', confidence: 0.95 },
    { label: 'unexpected', confidence: 0.55 },
  ],
  safetyFlags: [
    { flag: 'potentially_distressing', confidence: 0.2, note: 'The cat may be startled.' },
  ],
  analysis: {
    hook: 'Cat spots the vacuum.',
    setup: null,
    payoff: 'Cat rides it.',
    emotionalDriver: 'surprise',
    novelty: null,
    pacingNotes: null,
    audienceAppeal: 'pet owners',
    reusableFormat: 'pet vs gadget',
    suggestedTheme: 'pets meet tech',
    whyItMayWork: 'No context needed.',
  },
};

async function clusterOf(platformVideoId: string) {
  const [v] = await db
    .select()
    .from(schema.videos)
    .where(eq(schema.videos.platformVideoId, platformVideoId));
  return { videoId: v!.id, clusterId: v!.clusterId! };
}

describe('clusters', () => {
  it('every ingested video gets a singleton cluster with itself as representative', async () => {
    await runDiscovery(testDeps(db, [youtube()], clock.now), {
      adapterId: 'youtube',
      kind: 'trending',
      params: { regionCode: 'US' },
      limit: 50,
    });
    const vids = await db.select().from(schema.videos);
    expect(vids.every((v) => v.clusterId)).toBe(true);
    const cls = await db.select().from(schema.clusters);
    expect(cls).toHaveLength(vids.length);
    expect(new Set(cls.map((c) => c.representativeVideoId))).toEqual(
      new Set(vids.map((v) => v.id)),
    );
  });
});

describe('classifyCluster', () => {
  it('stores a versioned, provider-neutral classification from permitted inputs only', async () => {
    const deps = testDeps(db, [youtube(), bluesky()], clock.now);
    await runDiscovery(deps, {
      adapterId: 'youtube',
      kind: 'trending',
      params: { regionCode: 'US' },
      limit: 50,
    });
    await runDiscovery(deps, {
      adapterId: 'bluesky',
      kind: 'search',
      params: { q: 'funny' },
      limit: 50,
    });
    const { clusterId, videoId } = await clusterOf('vdFixture01');

    const { input } = await buildClassificationInput(deps, clusterId);
    expect(input).toMatchObject({
      platform: 'youtube',
      title: 'Cat discovers the vacuum cleaner',
      durationMs: 42_000,
      creator: { displayName: 'Fixture Pets' },
      thumbnailUrl: 'https://i.ytimg.com/vi/vdFixture01/hqdefault.jpg',
      discoveryContext: ['bluesky: search "funny"', 'youtube: mostPopular chart US'],
    });

    const classifier = createFakeClassifier({ respond: () => output });
    const r = await classifyCluster(deps, clusterId, { classifier });
    expect(r.status).toBe('classified');
    const row = await latestClassification(deps, clusterId);
    expect(row).toMatchObject({
      clusterId,
      videoId,
      provider: 'fake',
      model: 'fake-classifier-1',
      taxonomyVersion: TAXONOMY_VERSION,
      promptVersion: PROMPT_VERSION,
      rationale: 'A cat meets a robot vacuum.',
      labels: [
        { label: 'animals', confidence: 0.95 },
        { label: 'funny', confidence: 0.9 },
        { label: 'unexpected', confidence: 0.55 },
      ],
      safetyFlags: [{ flag: 'potentially_distressing', confidence: 0.2 }],
      analysis: { hook: 'Cat spots the vacuum.', setup: null },
      inputsUsed: { thumbnail: 'used', title: true, discoveryContext: 2 },
    });
    expect(row!.inputHash).toHaveLength(64);
  });

  it('is idempotent; force keeps history; changed inputs re-qualify; score changes do not', async () => {
    const deps = testDeps(db, [youtube()], clock.now);
    await runDiscovery(deps, {
      adapterId: 'youtube',
      kind: 'trending',
      params: { regionCode: 'US' },
      limit: 50,
    });
    const { clusterId, videoId } = await clusterOf('vdFixture01');
    const classifier = createFakeClassifier({ respond: () => output });

    expect((await classifyCluster(deps, clusterId, { classifier })).status).toBe('classified');
    expect((await classifyCluster(deps, clusterId, { classifier })).status).toBe('unchanged');

    clock.advance(3_600_000);
    await scoreVideo(deps, videoId); // virality changes are not content changes
    expect((await classifyCluster(deps, clusterId, { classifier })).status).toBe('unchanged');

    expect((await classifyCluster(deps, clusterId, { classifier, force: true })).status).toBe(
      'classified',
    );
    await db
      .update(schema.videos)
      .set({ title: 'Cat vs vacuum (full story)' })
      .where(eq(schema.videos.id, videoId));
    expect((await classifyCluster(deps, clusterId, { classifier })).status).toBe('classified');

    const history = await db
      .select()
      .from(schema.classifications)
      .where(eq(schema.classifications.clusterId, clusterId));
    expect(history).toHaveLength(3);
    expect(classifier.calls).toHaveLength(3);
  });

  it('quarantines invalid output, keeps no malformed classification, and stops retrying unchanged input', async () => {
    const deps = testDeps(db, [youtube()], clock.now);
    await runDiscovery(deps, {
      adapterId: 'youtube',
      kind: 'trending',
      params: { regionCode: 'US' },
      limit: 50,
    });
    const { clusterId } = await clusterOf('vdFixture01');
    const broken = createFakeClassifier({
      respond: () => ({ labels: [{ label: 'hilarious', confidence: 2 }] }),
    });

    for (let i = 0; i < 3; i++) {
      const r = await classifyCluster(deps, clusterId, { classifier: broken });
      expect(r).toMatchObject({
        status: 'failed',
        error: { kind: 'invalid_output', retryable: false },
      });
    }
    expect((await classifyCluster(deps, clusterId, { classifier: broken })).status).toBe('skipped');
    expect(await db.select().from(schema.classifications)).toEqual([]);
    const failures = await db.select().from(schema.classificationFailures);
    expect(failures).toHaveLength(3);
    expect(failures[0]).toMatchObject({
      errorKind: 'invalid_output',
      provider: 'fake',
      taxonomyVersion: TAXONOMY_VERSION,
    });
    expect(failures[0]!.details.length).toBeGreaterThan(0);
  });

  it('records a text-only classification when the thumbnail cannot be used', async () => {
    const deps = testDeps(db, [youtube()], clock.now);
    await runDiscovery(deps, {
      adapterId: 'youtube',
      kind: 'trending',
      params: { regionCode: 'US' },
      limit: 50,
    });
    const { clusterId } = await clusterOf('vdFixture01');
    await classifyCluster(deps, clusterId, {
      classifier: createFakeClassifier({ respond: () => output, rejectThumbnails: true }),
    });
    expect((await latestClassification(deps, clusterId))!.inputsUsed).toMatchObject({
      thumbnail: 'unavailable',
    });
  });
});

describe('classification gate', () => {
  it('selects high-scoring and saved/approved clusters only', async () => {
    const deps = testDeps(db, [youtube(), bluesky()], clock.now);
    await runDiscovery(deps, {
      adapterId: 'youtube',
      kind: 'trending',
      params: { regionCode: 'US' },
      limit: 50,
    });
    await runDiscovery(deps, {
      adapterId: 'bluesky',
      kind: 'search',
      params: { q: 'funny' },
      limit: 50,
    });
    const cat = await clusterOf('vdFixture01');
    const kitchen = await clusterOf('vdFixture02');
    const tiktok = await clusterOf('7412345678901234567');
    await scoreVideo(deps, cat.videoId);
    await scoreVideo(deps, kitchen.videoId);
    await scoreVideo(deps, tiktok.videoId); // insufficient evidence
    const scoreOf = async (id: string) =>
      (await db.select().from(schema.scores).where(eq(schema.scores.videoId, id)))[0]!.value;
    const catScore = (await scoreOf(cat.videoId))!;
    const kitchenScore = (await scoreOf(kitchen.videoId))!;
    const threshold = (catScore + kitchenScore) / 2;
    const policy = { ...DEFAULT_CLASSIFICATION_POLICY, minScore: threshold };
    const high = catScore > kitchenScore ? cat : kitchen;

    expect(await selectClassificationCandidates(deps, policy, 100)).toEqual([high.clusterId]);
    await db
      .insert(schema.reviewEvents)
      .values({ clusterId: tiktok.clusterId, status: 'saved', createdAt: clock.now() });
    expect((await selectClassificationCandidates(deps, policy, 100)).sort()).toEqual(
      [high.clusterId, tiktok.clusterId].sort(),
    );

    const classifier = createFakeClassifier({ respond: () => output });
    const first = await classifyEligible(deps, { classifier, policy, limit: 100 });
    expect(first).toMatchObject({ considered: 2, classified: 2 });
    const second = await classifyEligible(deps, { classifier, policy, limit: 100 });
    expect(second).toMatchObject({ classified: 0, unchanged: 2 });
  });

  it('describes discovery context generically', () => {
    expect(describeContext('yt-funny', { search: { q: 'funny animals' } })).toBe(
      'yt-funny: search "funny animals"',
    );
    expect(describeContext('bluesky', { query: 'fails', postUri: 'at://x' })).toBe(
      'bluesky: search "fails"',
    );
    expect(describeContext('twitch', { gameId: '509658' })).toBe('twitch: top clips for a game');
    expect(describeContext('manual-url', { submittedUrl: 'https://youtu.be/x' })).toBe(
      'manual-url: submitted by a reviewer',
    );
  });
});
