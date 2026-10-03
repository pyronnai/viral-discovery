/**
 * Storage for normalized adapter output. Platform-agnostic: nothing here knows
 * which adapter produced an item, only whether the observation is AUTHORITATIVE
 * (the adapter's own platform) or a REFERENCE (a link to another platform).
 *
 *  - Authoritative observations update the video (non-null values win), write
 *    the raw payload, and record a metric snapshot.
 *  - References only fill fields that are still empty and never write metrics.
 */
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm';
import type { NormalizedCreator, NormalizedVideo, RawItem } from '@vd/adapter-contract';
import {
  METRIC_KEYS,
  type MetricKey,
  type MetricReadings,
  type MetricUnavailableReason,
} from '@vd/core';
import { schema, type AnyDatabase } from '@vd/db';

const { creators, videos, sightings, metricSnapshots, apiUsage, clusters } = schema;

type Tx = Parameters<Parameters<AnyDatabase['transaction']>[0]>[0];
export type Executor = AnyDatabase | Tx;

/** `excluded` wins when non-null (authoritative), or only fills a null (reference). */
function merge(column: AnyColumn, authoritative: boolean): SQL {
  const incoming = sql.raw(`excluded."${column.name}"`);
  return authoritative
    ? sql`coalesce(${incoming}, ${column})`
    : sql`coalesce(${column}, ${incoming})`;
}

export async function upsertCreator(
  db: Executor,
  creator: NormalizedCreator,
  authoritative: boolean,
): Promise<string | null> {
  // Without a stable platform id there is nothing to key a creator row on; the
  // observed handle/name still lands on the video row.
  if (!creator.platformCreatorId) return null;
  const [row] = await db
    .insert(creators)
    .values({
      platform: creator.platform,
      platformCreatorId: creator.platformCreatorId,
      handle: creator.handle,
      displayName: creator.displayName,
      profileUrl: creator.profileUrl,
      followerCount: creator.followerCount,
      lastRefreshedAt: authoritative ? new Date() : null,
    })
    .onConflictDoUpdate({
      target: [creators.platform, creators.platformCreatorId],
      set: {
        handle: merge(creators.handle, authoritative),
        displayName: merge(creators.displayName, authoritative),
        profileUrl: merge(creators.profileUrl, authoritative),
        followerCount: merge(creators.followerCount, authoritative),
        lastRefreshedAt: merge(creators.lastRefreshedAt, authoritative),
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: creators.id });
  return row?.id ?? null;
}

export async function upsertVideo(
  db: Executor,
  video: NormalizedVideo,
  options: { authoritative: boolean; creatorId: string | null; raw: RawItem },
): Promise<{ id: string; clusterId: string | null; inserted: boolean }> {
  const { authoritative, creatorId, raw } = options;
  const keep = (column: AnyColumn) => merge(column, authoritative);
  const [row] = await db
    .insert(videos)
    .values({
      platform: video.platform,
      platformVideoId: video.platformVideoId,
      canonicalUrl: video.canonicalUrl,
      creatorId,
      creatorHandle: video.creator?.handle ?? null,
      creatorDisplayName: video.creator?.displayName ?? null,
      title: video.title,
      caption: video.caption,
      publishedAt: video.publishedAt,
      durationMs: video.durationMs,
      thumbnailUrl: video.thumbnailUrl,
      language: video.language,
      contentOrigin: video.contentOrigin,
      availability: video.availability,
      // Platform moderation describes the canonical item; a reference never sets it.
      sourceModerationLabels: authoritative ? (video.moderationLabels ?? null) : null,
      // Raw payloads are kept only from the canonical platform (retention-sensitive).
      rawPayload: authoritative ? raw.payload : null,
      rawPayloadFetchedAt: authoritative ? raw.fetchedAt : null,
      firstDiscoveredAt: video.observedAt,
      lastRefreshedAt: authoritative && video.metrics ? video.observedAt : null,
    })
    .onConflictDoUpdate({
      target: [videos.platform, videos.platformVideoId],
      set: {
        canonicalUrl: authoritative
          ? sql.raw(`excluded."canonical_url"`)
          : sql`${videos.canonicalUrl}`,
        creatorId: keep(videos.creatorId),
        creatorHandle: keep(videos.creatorHandle),
        creatorDisplayName: keep(videos.creatorDisplayName),
        title: keep(videos.title),
        caption: keep(videos.caption),
        publishedAt: keep(videos.publishedAt),
        durationMs: keep(videos.durationMs),
        thumbnailUrl: keep(videos.thumbnailUrl),
        language: keep(videos.language),
        availability: authoritative
          ? sql.raw(`excluded."availability"`)
          : sql`CASE WHEN ${videos.availability} = 'unknown' THEN excluded."availability" ELSE ${videos.availability} END`,
        // A reported label set (even empty) replaces the old one: labels can be retracted.
        sourceModerationLabels: keep(videos.sourceModerationLabels),
        rawPayload: keep(videos.rawPayload),
        rawPayloadFetchedAt: keep(videos.rawPayloadFetchedAt),
        firstDiscoveredAt: sql`least(${videos.firstDiscoveredAt}, excluded."first_discovered_at")`,
        lastRefreshedAt: keep(videos.lastRefreshedAt),
        // Matching inputs changed → the video becomes eligible for near-duplicate analysis again.
        duplicateScannedAt: sql`CASE WHEN ${keep(videos.title)} IS DISTINCT FROM ${videos.title}
          OR ${keep(videos.caption)} IS DISTINCT FROM ${videos.caption}
          OR ${keep(videos.durationMs)} IS DISTINCT FROM ${videos.durationMs}
          OR ${keep(videos.publishedAt)} IS DISTINCT FROM ${videos.publishedAt}
          OR ${keep(videos.thumbnailUrl)} IS DISTINCT FROM ${videos.thumbnailUrl}
          THEN NULL ELSE ${videos.duplicateScannedAt} END`,
        updatedAt: sql`now()`,
      },
    })
    // xmax = 0 only for a freshly inserted row version.
    .returning({
      id: videos.id,
      clusterId: videos.clusterId,
      inserted: sql<boolean>`(xmax = 0)`,
    });
  if (!row) throw new Error('video upsert returned no row');
  return row;
}

/**
 * Every video belongs to a cluster (review and classification are per cluster).
 * A new video gets a singleton cluster (exact identity); near-duplicate analysis
 * (@vd/dedupe) may later merge it into another cluster once confirmed.
 */
export async function ensureCluster(
  db: Executor,
  videoId: string,
  clusterId: string | null,
): Promise<string> {
  if (clusterId) return clusterId;
  const [cluster] = await db
    .insert(clusters)
    .values({ representativeVideoId: videoId })
    .returning({ id: clusters.id });
  if (!cluster) throw new Error('cluster insert returned no row');
  await db.update(videos).set({ clusterId: cluster.id }).where(eq(videos.id, videoId));
  return cluster.id;
}

export async function insertSighting(
  db: Executor,
  values: { videoId: string; sourceId: string; runId: string | null; raw: RawItem },
): Promise<boolean> {
  const rows = await db
    .insert(sightings)
    .values({
      videoId: values.videoId,
      sourceId: values.sourceId,
      discoveryRunId: values.runId,
      context: values.raw.context,
      observationKey: values.raw.observationKey ?? values.raw.externalId,
      seenAt: values.raw.fetchedAt,
    })
    .onConflictDoNothing({
      target: [sightings.discoveryRunId, sightings.videoId, sightings.observationKey],
    })
    .returning({ id: sightings.id });
  return rows.length > 0;
}

/** Readings → nullable columns + `unavailable` reasons. A value is never invented. */
export function readingsToColumns(readings: MetricReadings) {
  const values: Partial<Record<MetricKey, number | null>> = {};
  const unavailable: Partial<Record<MetricKey, MetricUnavailableReason>> = {};
  for (const key of METRIC_KEYS) {
    const reading = readings[key];
    if (reading.kind === 'value') values[key] = reading.value;
    else {
      values[key] = null;
      unavailable[key] = reading.reason;
    }
  }
  return { ...values, unavailable };
}

export async function insertSnapshot(
  db: Executor,
  values: { videoId: string; sourceId: string; capturedAt: Date; readings: MetricReadings },
): Promise<boolean> {
  const rows = await db
    .insert(metricSnapshots)
    .values({
      videoId: values.videoId,
      sourceId: values.sourceId,
      capturedAt: values.capturedAt,
      ...readingsToColumns(values.readings),
    })
    .onConflictDoNothing({ target: [metricSnapshots.videoId, metricSnapshots.capturedAt] })
    .returning({ id: metricSnapshots.id });
  return rows.length > 0;
}

/** Adds this run's per-bucket usage (units and metered requests) to today's api_usage rows. */
export async function recordApiUsage(
  db: Executor,
  sourceId: string,
  usageDate: string,
  usage: Readonly<Record<string, number>>,
  requests: Readonly<Record<string, number>> = {},
): Promise<void> {
  for (const bucket of new Set([...Object.keys(usage), ...Object.keys(requests)])) {
    const units = usage[bucket] ?? 0;
    const count = requests[bucket] ?? 0;
    if (units <= 0 && count <= 0) continue;
    await db
      .insert(apiUsage)
      .values({ sourceId, usageDate, quotaBucket: bucket, unitsUsed: units, requestCount: count })
      .onConflictDoUpdate({
        target: [apiUsage.sourceId, apiUsage.usageDate, apiUsage.quotaBucket],
        set: {
          unitsUsed: sql`${apiUsage.unitsUsed} + ${units}`,
          requestCount: sql`${apiUsage.requestCount} + ${count}`,
          updatedAt: sql`now()`,
        },
      });
  }
}

export async function usedToday(db: Executor, sourceId: string, usageDate: string) {
  const rows = await db
    .select({ bucket: apiUsage.quotaBucket, units: apiUsage.unitsUsed })
    .from(apiUsage)
    .where(and(eq(apiUsage.sourceId, sourceId), eq(apiUsage.usageDate, usageDate)));
  return Object.fromEntries(rows.map((r) => [r.bucket, r.units]));
}
