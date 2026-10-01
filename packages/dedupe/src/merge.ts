/**
 * Cluster consolidation and human duplicate decisions.
 *
 * A merge never deletes anything. Videos (with their own sightings, metric
 * snapshots and score histories) move to the surviving cluster; cluster-level
 * histories (review events, rights records, classifications, classification
 * failures) move too, tagged with the cluster they came from. The absorbed
 * cluster row stays, pointing at the survivor, so old links redirect.
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { schema, type AnyDatabase } from '@vd/db';
import {
  clusterDecisionState,
  mergeConflicts,
  rows,
  type ClusterDecisionState,
  type Executor,
} from './state.ts';

export class DuplicateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateError';
  }
}

// ── representative selection ───────────────────────────────────────────────
export interface RepresentativeCandidate {
  id: string;
  availability: string;
  hasMetrics: boolean;
  /** Has a measured virality score (scored/provisional — its size is never compared). */
  hasScore: boolean;
  thumbnailUrl: string | null;
  title: string | null;
  durationMs: number | null;
  publishedAt: Date | null;
  hasCreator: boolean;
  firstDiscoveredAt: Date;
}

/**
 * Deterministic representative policy (first difference wins):
 *  1. available > unknown > private/removed (a card must be openable);
 *  2. has a virality score — so a merge never hides the cluster's measured evidence
 *     (whether a score EXISTS, never how high it is);
 *  3. has canonical metric snapshots (authoritative platform measurements);
 *  4. usable https thumbnail;
 *  5. richer canonical metadata (title, duration, publish time, creator);
 *  6. earliest publish time (the likelier original upload — NOT the more popular one);
 *  7. earliest first discovery, then id.
 * View counts and score values are never compared.
 */
export const REPRESENTATIVE_POLICY = [
  'available',
  'has_score',
  'canonical_metrics',
  'usable_thumbnail',
  'metadata_richness',
  'earliest_published',
  'earliest_discovered',
  'id',
] as const;

const AVAILABILITY_RANK: Record<string, number> = {
  available: 0,
  unknown: 1,
  private: 2,
  removed: 3,
};

export function chooseRepresentative<T extends RepresentativeCandidate>(videos: readonly T[]): T {
  const key = (v: RepresentativeCandidate) => [
    AVAILABILITY_RANK[v.availability] ?? 4,
    v.hasScore ? 0 : 1,
    v.hasMetrics ? 0 : 1,
    v.thumbnailUrl && /^https:\/\//.test(v.thumbnailUrl) ? 0 : 1,
    -[v.title, v.durationMs, v.publishedAt, v.hasCreator || null].filter((x) => x !== null).length,
    v.publishedAt ? new Date(v.publishedAt).getTime() : Number.MAX_SAFE_INTEGER,
    new Date(v.firstDiscoveredAt).getTime(),
  ];
  const sorted = [...videos].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (const [i, x] of ka.entries()) {
      const y = kb[i] ?? 0;
      if (x !== y) return x - y;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const first = sorted[0];
  if (!first) throw new DuplicateError('cluster has no videos');
  return first;
}

async function representativeCandidates(db: Executor, clusterId: string) {
  return rows<RepresentativeCandidate>(
    db,
    sql`select v.id, v.availability::text as availability, v.thumbnail_url as "thumbnailUrl", v.title,
        v.duration_ms as "durationMs", v.published_at as "publishedAt", v.first_discovered_at as "firstDiscoveredAt",
        (v.creator_id is not null or v.creator_display_name is not null or v.creator_handle is not null) as "hasCreator",
        exists(select 1 from metric_snapshots m where m.video_id = v.id) as "hasMetrics",
        exists(select 1 from scores s where s.video_id = v.id and s.value is not null) as "hasScore"
      from videos v where v.cluster_id = ${clusterId}::uuid`,
  );
}

// ── merge ──────────────────────────────────────────────────────────────────
export interface MergeResult {
  survivorClusterId: string;
  absorbedClusterId: string;
  representativeVideoId: string;
  reviewConflict: boolean;
  rightsConflict: boolean;
  mergeId: string;
}

async function sideSummary(db: Executor, clusterId: string, state: ClusterDecisionState) {
  const platforms = await rows<{ platform: string }>(
    db,
    sql`select distinct platform from videos where cluster_id = ${clusterId}::uuid order by platform`,
  );
  return {
    clusterId,
    platforms: platforms.map((p) => p.platform),
    review: state.review,
    reviewConflict: state.reviewConflict,
    rights: state.rights,
    rightsHolder: state.rightsHolder,
    rightsConflict: state.rightsConflict,
  };
}

/** Merges two ACTIVE clusters inside the caller's transaction. The older cluster survives. */
export async function mergeClusters(
  tx: Executor,
  input: {
    clusterIds: [string, string];
    candidateId: string | null;
    trigger: 'human' | 'auto';
    now: Date;
  },
): Promise<MergeResult> {
  const [x, y] = input.clusterIds;
  if (x === y) throw new DuplicateError('both videos are already in the same cluster');
  const locked = await rows<{
    id: string;
    createdAt: Date;
    mergedInto: string | null;
    rep: string | null;
  }>(
    tx,
    sql`select id, created_at as "createdAt", merged_into_cluster_id as "mergedInto", representative_video_id as rep
      from clusters where id in (${x}::uuid, ${y}::uuid) order by id for update`,
  );
  if (locked.length !== 2) throw new DuplicateError('cluster not found');
  if (locked.some((c) => c.mergedInto))
    throw new DuplicateError('a cluster was already merged; refresh and retry');
  const [survivor, absorbed] = [...locked].sort(
    (a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || (a.id < b.id ? -1 : 1),
  ) as [(typeof locked)[0], (typeof locked)[0]];

  const [sState, aState] = [
    await clusterDecisionState(tx, survivor.id),
    await clusterDecisionState(tx, absorbed.id),
  ];
  const conflicts = mergeConflicts(sState, aState);
  const sides = [
    { role: 'survivor', ...(await sideSummary(tx, survivor.id, sState)) },
    { role: 'absorbed', ...(await sideSummary(tx, absorbed.id, aState)) },
  ];

  const S = survivor.id;
  const A = absorbed.id;
  const moved = {
    videos: (
      await tx
        .update(schema.videos)
        .set({ clusterId: S })
        .where(eq(schema.videos.clusterId, A))
        .returning({ id: schema.videos.id })
    ).length,
    reviewEvents: (
      await tx
        .update(schema.reviewEvents)
        .set({
          clusterId: S,
          originClusterId: sql`coalesce(${schema.reviewEvents.originClusterId}, ${A}::uuid)`,
        })
        .where(eq(schema.reviewEvents.clusterId, A))
        .returning({ id: schema.reviewEvents.id })
    ).length,
    rights: (
      await tx
        .update(schema.rights)
        .set({
          clusterId: S,
          originClusterId: sql`coalesce(${schema.rights.originClusterId}, ${A}::uuid)`,
        })
        .where(eq(schema.rights.clusterId, A))
        .returning({ id: schema.rights.id })
    ).length,
    classifications: (
      await tx
        .update(schema.classifications)
        .set({ clusterId: S })
        .where(eq(schema.classifications.clusterId, A))
        .returning({ id: schema.classifications.id })
    ).length,
    classificationFailures: (
      await tx
        .update(schema.classificationFailures)
        .set({ clusterId: S })
        .where(eq(schema.classificationFailures.clusterId, A))
        .returning({ id: schema.classificationFailures.id })
    ).length,
    acquisitionEvents: (
      await tx
        .update(schema.acquisitionEvents)
        .set({
          clusterId: S,
          originClusterId: sql`coalesce(${schema.acquisitionEvents.originClusterId}, ${A}::uuid)`,
        })
        .where(eq(schema.acquisitionEvents.clusterId, A))
        .returning({ id: schema.acquisitionEvents.id })
    ).length,
  };
  // Facts about the content carry over to the whole cluster, whichever side's
  // record happens to be newer: used content stays used; obtained stays obtained.
  const after = await clusterDecisionState(tx, S);
  const inherited = { alreadyUsed: false, obtained: false };
  if (
    (sState.review === 'already_used' || aState.review === 'already_used') &&
    after.review !== 'already_used'
  ) {
    await tx.insert(schema.reviewEvents).values({
      clusterId: S,
      status: 'already_used',
      reviewer: 'system',
      note: 'another representation of this clip was already used',
      createdAt: input.now,
    });
    inherited.alreadyUsed = true;
  }
  if (
    (sState.acquisition === 'obtained' || aState.acquisition === 'obtained') &&
    after.acquisition !== 'obtained'
  ) {
    await tx.insert(schema.acquisitionEvents).values({
      clusterId: S,
      status: 'obtained',
      note: 'obtained via another representation of this clip',
      createdAt: input.now,
    });
    inherited.obtained = true;
  }
  // Open suggestions between versions that now share the cluster are moot (machine
  // suggestions only — human decisions are never touched).
  const settled = await rows<{ id: string }>(
    tx,
    sql`delete from duplicate_candidates d using videos va, videos vb
      where d.status = 'possible' and va.id = d.video_a_id and vb.id = d.video_b_id
        and va.cluster_id = ${S}::uuid and vb.cluster_id = ${S}::uuid
        ${input.candidateId ? sql`and d.id <> ${input.candidateId}::uuid` : sql``}
      returning d.id`,
  );
  // Keep redirects one hop deep: clusters previously merged into A now point at S.
  await tx
    .update(schema.clusters)
    .set({ mergedIntoClusterId: S })
    .where(eq(schema.clusters.mergedIntoClusterId, A));
  await tx
    .update(schema.clusters)
    .set({
      mergedIntoClusterId: S,
      mergedAt: input.now,
      representativeVideoId: null,
      updatedAt: input.now,
    })
    .where(eq(schema.clusters.id, A));

  const representative = chooseRepresentative(await representativeCandidates(tx, S));
  await tx
    .update(schema.clusters)
    .set({ representativeVideoId: representative.id, updatedAt: input.now })
    .where(eq(schema.clusters.id, S));

  const [merge] = await tx
    .insert(schema.clusterMerges)
    .values({
      survivorClusterId: S,
      absorbedClusterId: A,
      duplicateCandidateId: input.candidateId,
      trigger: input.trigger,
      representativeVideoId: representative.id,
      reviewConflict: conflicts.review,
      rightsConflict: conflicts.rights,
      details: {
        sides,
        moved,
        settledSuggestions: settled.length,
        inherited,
        reviewReason: conflicts.reviewReason,
        rightsReason: conflicts.rightsReason,
        representative: {
          before: [survivor.rep, absorbed.rep],
          after: representative.id,
          policy: REPRESENTATIVE_POLICY,
        },
      },
      mergedAt: input.now,
    })
    .returning({ id: schema.clusterMerges.id });
  if (!merge) throw new DuplicateError('merge was not recorded');
  return {
    survivorClusterId: S,
    absorbedClusterId: A,
    representativeVideoId: representative.id,
    reviewConflict: conflicts.review,
    rightsConflict: conflicts.rights,
    mergeId: merge.id,
  };
}

// ── human decisions ────────────────────────────────────────────────────────
async function loadCandidate(db: Executor, candidateId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(candidateId)) throw new DuplicateError('invalid duplicate id');
  const [row] = await rows<{
    id: string;
    status: string;
    videoAId: string;
    videoBId: string;
    clusterA: string | null;
    clusterB: string | null;
  }>(
    db,
    sql`select d.id, d.status::text as status, d.video_a_id as "videoAId", d.video_b_id as "videoBId",
        va.cluster_id as "clusterA", vb.cluster_id as "clusterB"
      from duplicate_candidates d
      join videos va on va.id = d.video_a_id join videos vb on vb.id = d.video_b_id
      where d.id = ${candidateId}::uuid`,
  );
  if (!row) throw new DuplicateError('duplicate candidate not found');
  if (!row.clusterA || !row.clusterB) throw new DuplicateError('video has no cluster');
  return row as typeof row & { clusterA: string; clusterB: string };
}

/** Rejected pairs (other than `exceptId`) connecting two clusters. */
export async function rejectedBetween(
  db: Executor,
  clusterA: string,
  clusterB: string,
  exceptId?: string,
) {
  return rows<{ id: string }>(
    db,
    sql`select d.id from duplicate_candidates d
      join videos va on va.id = d.video_a_id join videos vb on vb.id = d.video_b_id
      where d.status = 'rejected'
        and ((va.cluster_id = ${clusterA}::uuid and vb.cluster_id = ${clusterB}::uuid)
          or (va.cluster_id = ${clusterB}::uuid and vb.cluster_id = ${clusterA}::uuid))
        ${exceptId ? sql`and d.id <> ${exceptId}::uuid` : sql``}`,
  );
}

function cleanNote(note: string | null | undefined) {
  const t = note?.trim();
  if (!t) return null;
  if (t.length > 500) throw new DuplicateError('note is limited to 500 characters');
  return t;
}

export interface DecisionOptions {
  note?: string | null;
  now?: Date;
  decidedBy?: string;
}

/** CONFIRM SAME VIDEO: marks the pair confirmed and merges the two clusters. */
export async function confirmDuplicate(
  db: AnyDatabase,
  candidateId: string,
  options: DecisionOptions = {},
): Promise<{ merge: MergeResult | null; alreadyMerged: boolean }> {
  const now = options.now ?? new Date();
  const note = cleanNote(options.note);
  return db.transaction(async (tx) => {
    const c = await loadCandidate(tx, candidateId);
    const decided = {
      status: 'confirmed' as const,
      decidedAt: now,
      decidedBy: options.decidedBy ?? 'owner',
      note,
    };
    if (c.clusterA === c.clusterB) {
      if (c.status !== 'confirmed' && c.status !== 'auto_confirmed')
        await tx
          .update(schema.duplicateCandidates)
          .set(decided)
          .where(eq(schema.duplicateCandidates.id, c.id));
      return { merge: null, alreadyMerged: true };
    }
    const contradicting = await rejectedBetween(tx, c.clusterA, c.clusterB, c.id);
    if (contradicting.length) {
      throw new DuplicateError(
        'another version of these candidates was already marked "not the same"; they cannot be merged automatically',
      );
    }
    const merge = await mergeClusters(tx, {
      clusterIds: [c.clusterA, c.clusterB],
      candidateId: c.id,
      trigger: 'human',
      now,
    });
    await tx
      .update(schema.duplicateCandidates)
      .set(decided)
      .where(eq(schema.duplicateCandidates.id, c.id));
    return { merge, alreadyMerged: false };
  });
}

/**
 * NOT THE SAME: marks the pair rejected. The decision is cluster-level ("these two
 * pieces of content differ"), so other open suggestions between the same two
 * clusters are rejected too. Rejected pairs are never resurfaced by the detector.
 */
export async function rejectDuplicate(
  db: AnyDatabase,
  candidateId: string,
  options: DecisionOptions = {},
): Promise<{ rejected: number }> {
  const now = options.now ?? new Date();
  const note = cleanNote(options.note);
  return db.transaction(async (tx) => {
    const c = await loadCandidate(tx, candidateId);
    if (c.clusterA === c.clusterB) {
      throw new DuplicateError('these versions are already merged; un-merging is not supported');
    }
    const decidedBy = options.decidedBy ?? 'owner';
    await tx
      .update(schema.duplicateCandidates)
      .set({ status: 'rejected', decidedAt: now, decidedBy, note })
      .where(eq(schema.duplicateCandidates.id, c.id));
    const others = await rows<{ id: string }>(
      tx,
      sql`select d.id from duplicate_candidates d
        join videos va on va.id = d.video_a_id join videos vb on vb.id = d.video_b_id
        where d.status = 'possible' and d.id <> ${c.id}::uuid
          and ((va.cluster_id = ${c.clusterA}::uuid and vb.cluster_id = ${c.clusterB}::uuid)
            or (va.cluster_id = ${c.clusterB}::uuid and vb.cluster_id = ${c.clusterA}::uuid))`,
    );
    if (others.length) {
      await tx
        .update(schema.duplicateCandidates)
        .set({
          status: 'rejected',
          decidedAt: now,
          decidedBy,
          note: 'rejected with another version of the same pair',
        })
        .where(
          and(
            inArray(
              schema.duplicateCandidates.id,
              others.map((o) => o.id),
            ),
            ne(schema.duplicateCandidates.status, 'rejected'),
          ),
        );
    }
    return { rejected: 1 + others.length };
  });
}

/** Follows merged_into pointers (one hop after flattening; loops are impossible but bounded anyway). */
export async function resolveCluster(db: Executor, clusterId: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(clusterId)) return null;
  let current = clusterId;
  for (let i = 0; i < 5; i++) {
    const [row] = await db
      .select({ id: schema.clusters.id, into: schema.clusters.mergedIntoClusterId })
      .from(schema.clusters)
      .where(eq(schema.clusters.id, current));
    if (!row) return null;
    if (!row.into) return row.id;
    current = row.into;
  }
  return current;
}
