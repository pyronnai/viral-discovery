/**
 * Deterministic fixtures for review/feed/detail tests: an in-process Postgres
 * with the real migrations, seeded with candidates whose scores come from the
 * real scorer. Fixed timestamps only. Imported by *.test.ts files only.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import { PROMPT_VERSION, TAXONOMY_VERSION } from '@vd/classification';
import { MIGRATIONS_FOLDER, schema, type AnyDatabase } from '@vd/db';
import { scoreCandidate, type SightingInput, type SnapshotInput } from '@vd/scoring';
import type { SightingRoles } from './present.ts';

export const NOW = new Date('2026-09-29T12:00:00Z');
export const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
export const ROLES: SightingRoles = {
  youtube: 'propagation',
  twitch: 'propagation',
  bluesky: 'propagation',
  'manual-url': 'provenance',
};
const PLATFORM: Record<string, string> = {
  youtube: 'youtube',
  twitch: 'twitch',
  bluesky: 'bluesky',
  'manual-url': 'manual',
};

export async function createTestDb(): Promise<{ db: AnyDatabase; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, {
    migrationsFolder: MIGRATIONS_FOLDER,
    migrationsSchema: 'drizzle',
    migrationsTable: '__drizzle_migrations',
  });
  return { db, close: () => client.close() };
}

interface CandidateSpec {
  platform: string;
  platformVideoId: string;
  title: string | null;
  thumbnailUrl?: string | null;
  durationMs?: number | null;
  publishedAt?: Date | null;
  firstDiscoveredAt: Date;
  creator?: string | null;
  snapshots?: {
    at: Date;
    views?: number | null;
    likes?: number | null;
    comments?: number | null;
  }[];
  sightings: {
    source: string;
    key: string;
    at: Date;
    engagement?: SightingInput['sourceEngagement'];
  }[];
  score?: boolean;
  classification?: {
    labels: { label: string; confidence: number }[];
    flags?: { flag: string; confidence: number; note: string }[];
    summary: string;
  };
}

export async function seedCandidate(
  db: AnyDatabase,
  spec: CandidateSpec,
): Promise<{ clusterId: string; videoId: string }> {
  const sources = new Map<string, string>();
  for (const s of spec.sightings) {
    await db
      .insert(schema.sources)
      .values({ name: s.source, adapterId: s.source, enabled: true })
      .onConflictDoNothing();
    const [row] = await db.select().from(schema.sources).where(eq(schema.sources.name, s.source));
    sources.set(s.source, row!.id);
  }
  const [video] = await db
    .insert(schema.videos)
    .values({
      platform: spec.platform,
      platformVideoId: spec.platformVideoId,
      canonicalUrl: `https://example.test/${spec.platform}/${spec.platformVideoId}`,
      title: spec.title,
      thumbnailUrl: spec.thumbnailUrl ?? null,
      durationMs: spec.durationMs ?? null,
      publishedAt: spec.publishedAt ?? null,
      firstDiscoveredAt: spec.firstDiscoveredAt,
      creatorDisplayName: spec.creator ?? null,
      availability: spec.snapshots?.length ? 'available' : 'unknown',
    })
    .returning();
  const [cluster] = await db
    .insert(schema.clusters)
    .values({ representativeVideoId: video!.id })
    .returning();
  await db
    .update(schema.videos)
    .set({ clusterId: cluster!.id })
    .where(eq(schema.videos.id, video!.id));

  for (const snap of spec.snapshots ?? []) {
    await db.insert(schema.metricSnapshots).values({
      videoId: video!.id,
      sourceId: sources.get(spec.sightings[0]!.source) ?? null,
      capturedAt: snap.at,
      views: snap.views ?? null,
      likes: snap.likes ?? null,
      comments: snap.comments ?? null,
    });
  }
  for (const s of spec.sightings) {
    await db.insert(schema.sightings).values({
      videoId: video!.id,
      sourceId: sources.get(s.source)!,
      observationKey: s.key,
      seenAt: s.at,
      context: s.engagement ? { postEngagement: s.engagement } : {},
    });
  }
  if (spec.score !== false) {
    const snapshots: SnapshotInput[] = (spec.snapshots ?? []).map((x) => ({
      capturedAt: x.at,
      metrics: {
        views: x.views ?? null,
        likes: x.likes ?? null,
        comments: x.comments ?? null,
        shares: null,
      },
    }));
    const r = scoreCandidate({
      platform: spec.platform,
      publishedAt: spec.publishedAt ?? null,
      firstDiscoveredAt: spec.firstDiscoveredAt,
      snapshots,
      sightings: spec.sightings.map((s) => ({
        sourceId: sources.get(s.source)!,
        sourceLabel: s.source,
        role: ROLES[s.source] ?? 'provenance',
        sourcePlatform: PLATFORM[s.source] ?? null,
        observationKey: s.key,
        runId: null,
        seenAt: s.at,
        sourceEngagement: s.engagement ?? null,
      })),
      creator: null,
      population: { logVelocity: {}, engagementRate: {} },
      asOf: NOW,
    });
    await db.insert(schema.scores).values({
      videoId: video!.id,
      algorithmVersion: r.algorithmVersion,
      value: r.score,
      state: r.state,
      confidence: r.confidence,
      // The same shape the pipeline stores (scoreVideo).
      components: {
        ...r.components,
        _meta: {
          observations: r.observations,
          ...(r.viralNow ? { viralNow: r.viralNow } : {}),
        },
      },
      missingMetrics: r.missingMetrics,
      reasonCodes: r.reasonCodes,
      inputsHash: 'fixture',
      computedAt: NOW,
      nextRescoreAt: r.nextRescoreAt,
    });
  }
  if (spec.classification) {
    await db.insert(schema.classifications).values({
      clusterId: cluster!.id,
      videoId: video!.id,
      taxonomyVersion: TAXONOMY_VERSION,
      promptVersion: PROMPT_VERSION,
      provider: 'fake',
      model: 'fake-classifier-1',
      labels: spec.classification.labels,
      safetyFlags: spec.classification.flags ?? [],
      rationale: spec.classification.summary,
      analysis: {
        hook: 'Cat immediately notices the robot vacuum.',
        setup: 'Quiet living room; the vacuum starts.',
        payoff: 'The cat ends up riding it into the kitchen.',
        emotionalDriver: 'surprise',
        novelty: 'pet vs household robot',
        pacingNotes: null,
        audienceAppeal: 'pet owners; no context needed',
        reusableFormat: 'pet meets gadget',
        suggestedTheme: 'pets vs tech',
        whyItMayWork:
          'Immediate visual hook, universally understandable setup, escalating surprise.',
      },
      inputsUsed: { title: true, caption: false, thumbnail: 'used', discoveryContext: 2 },
      inputHash: 'fixture',
      createdAt: hoursAgo(1),
    });
  }
  return { clusterId: cluster!.id, videoId: video!.id };
}

/** The three walkthrough candidates plus two for ordering/pagination. */
export async function seedFeed(db: AnyDatabase) {
  const breakout = await seedCandidate(db, {
    platform: 'youtube',
    platformVideoId: 'vdFixture01',
    title: 'Cat discovers the vacuum cleaner',
    thumbnailUrl: 'https://i.ytimg.com/vi/vdFixture01/hqdefault.jpg',
    durationMs: 42_000,
    publishedAt: hoursAgo(11),
    firstDiscoveredAt: hoursAgo(8),
    creator: 'Fixture Pets',
    snapshots: [
      { at: hoursAgo(8), views: 12_000, likes: 900, comments: 60 },
      { at: hoursAgo(6), views: 48_000, likes: 3_900, comments: 240 },
      { at: NOW, views: 190_000, likes: 15_500, comments: 910 },
    ],
    sightings: [
      { source: 'youtube', key: 'search:funny animals:US', at: hoursAgo(8) },
      {
        source: 'bluesky',
        key: 'at://post1',
        at: hoursAgo(7),
        engagement: { likes: 420, reposts: 95, replies: 30, quotes: 6 },
      },
      {
        source: 'bluesky',
        key: 'at://post2',
        at: hoursAgo(5),
        engagement: { likes: 130, reposts: 22, replies: 8, quotes: 1 },
      },
      { source: 'manual-url', key: 'youtube:vdFixture01', at: hoursAgo(3) },
    ],
    classification: {
      labels: [
        { label: 'animals', confidence: 0.95 },
        { label: 'funny', confidence: 0.9 },
        { label: 'unexpected', confidence: 0.6 },
      ],
      summary: 'A cat encounters a robot vacuum and ends up riding it.',
    },
  });
  const provisional = await seedCandidate(db, {
    platform: 'twitch',
    platformVideoId: 'FixtureClip-abc',
    title: 'chat made me do it',
    thumbnailUrl: null,
    durationMs: 27_500,
    publishedAt: hoursAgo(2),
    firstDiscoveredAt: hoursAgo(1),
    creator: 'FixtureStreamer',
    snapshots: [{ at: hoursAgo(1), views: 4_200 }],
    sightings: [{ source: 'twitch', key: 'game:509658', at: hoursAgo(1) }],
  });
  const insufficient = await seedCandidate(db, {
    platform: 'tiktok',
    platformVideoId: '7412345678901234567',
    title: 'when the cat hears the treat bag #funny #cat',
    thumbnailUrl: 'https://p16-sign.tiktokcdn-us.com/fixture.jpeg',
    publishedAt: null,
    firstDiscoveredAt: hoursAgo(6),
    creator: 'Fixture Creator',
    sightings: [
      { source: 'manual-url', key: 'tiktok:7412345678901234567', at: hoursAgo(6) },
      {
        source: 'bluesky',
        key: 'at://post9',
        at: hoursAgo(5),
        engagement: { likes: 610, reposts: 140, replies: 45, quotes: 9 },
      },
    ],
  });
  const lower = await seedCandidate(db, {
    platform: 'youtube',
    platformVideoId: 'vdFixture02',
    title: 'Top 10 kitchen fails (full episode)',
    durationMs: 723_000,
    publishedAt: hoursAgo(120),
    firstDiscoveredAt: hoursAgo(10),
    creator: 'Fixture Comedy',
    snapshots: [
      { at: hoursAgo(10), views: 5_000_000, likes: 150_000, comments: 4_000 },
      { at: hoursAgo(8), views: 5_050_000, likes: 151_000, comments: 4_050 },
    ],
    sightings: [{ source: 'youtube', key: 'mostPopular:US:all', at: hoursAgo(10) }],
  });
  const unscored = await seedCandidate(db, {
    platform: 'youtube',
    platformVideoId: 'vdFixture03',
    title: 'Dog vs sprinkler',
    firstDiscoveredAt: hoursAgo(0.5),
    sightings: [{ source: 'youtube', key: 'mostPopular:US:all', at: hoursAgo(0.5) }],
    score: false,
  });
  return { breakout, provisional, insufficient, lower, unscored };
}
