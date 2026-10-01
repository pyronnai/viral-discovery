/**
 * The effective human-decision state of a cluster, and how two states combine
 * when clusters merge.
 *
 * Review and rights are append-only histories; the latest record is current.
 * A merge moves BOTH histories onto the surviving cluster (nothing is dropped)
 * and records whether the combination is a conflict. While a conflict is open,
 * the cluster has NO effective review decision / rights status; recording a new
 * decision after the merge resolves it.
 */
import { sql } from 'drizzle-orm';
import type { AnyDatabase } from '@vd/db';

type Tx = Parameters<Parameters<AnyDatabase['transaction']>[0]>[0];
export type Executor = AnyDatabase | Tx;

export async function rows<T>(db: Executor, query: ReturnType<typeof sql>): Promise<T[]> {
  const result = (await db.execute(query)) as { rows: T[] };
  return result.rows;
}

export interface ClusterDecisionState {
  review: string | null;
  reviewAt: Date | null;
  reviewConflict: boolean;
  rights: string | null;
  rightsHolder: string | null;
  rightsAt: Date | null;
  rightsConflict: boolean;
  /** Latest acquisition status ('obtained' | 'not_obtained'), or null. */
  acquisition: string | null;
  /** Any review event or rights record exists (human involvement). */
  hasHumanDecisions: boolean;
}

export async function clusterDecisionState(
  db: Executor,
  clusterId: string,
): Promise<ClusterDecisionState> {
  const [row] = await rows<{
    review: string | null;
    reviewAt: Date | null;
    reviewConflictAt: Date | null;
    rights: string | null;
    rightsHolder: string | null;
    rightsAt: Date | null;
    rightsConflictAt: Date | null;
    reviewCount: number;
    rightsCount: number;
    acquisition: string | null;
  }>(
    db,
    sql`select
      rv.status::text as review, rv.created_at as "reviewAt",
      (select max(merged_at) from cluster_merges where survivor_cluster_id = ${clusterId}::uuid and review_conflict) as "reviewConflictAt",
      rt.status::text as rights, rt.rights_holder as "rightsHolder", rt.created_at as "rightsAt",
      (select max(merged_at) from cluster_merges where survivor_cluster_id = ${clusterId}::uuid and rights_conflict) as "rightsConflictAt",
      (select count(*)::int from review_events where cluster_id = ${clusterId}::uuid) as "reviewCount",
      (select count(*)::int from rights where cluster_id = ${clusterId}::uuid) as "rightsCount",
      (select status::text from acquisition_events where cluster_id = ${clusterId}::uuid
        order by created_at desc, id desc limit 1) as acquisition
    from (select 1) one
    left join lateral (
      select status, created_at from review_events where cluster_id = ${clusterId}::uuid
      order by created_at desc, id desc limit 1
    ) rv on true
    left join lateral (
      select status, rights_holder, created_at from rights where cluster_id = ${clusterId}::uuid
      order by created_at desc, id desc limit 1
    ) rt on true`,
  );
  const open = (conflictAt: Date | null, at: Date | null) =>
    conflictAt !== null &&
    (at === null || new Date(at).getTime() <= new Date(conflictAt).getTime());
  const reviewConflict = open(row?.reviewConflictAt ?? null, row?.reviewAt ?? null);
  const rightsConflict = open(row?.rightsConflictAt ?? null, row?.rightsAt ?? null);
  return {
    // "cleared" (unsaved) means no current decision.
    review: row?.review === 'cleared' ? null : (row?.review ?? null),
    reviewAt: row?.reviewAt ?? null,
    reviewConflict,
    rights: row?.rights ?? null,
    rightsHolder: row?.rightsHolder ?? null,
    rightsAt: row?.rightsAt ?? null,
    rightsConflict,
    acquisition: row?.acquisition ?? null,
    hasHumanDecisions: (row?.reviewCount ?? 0) + (row?.rightsCount ?? 0) > 0,
  };
}

/** Rights that represent permission. A grant for one upload is not a grant for another. */
const PERMISSIVE = new Set(['granted', 'own_content']);

const sameHolder = (a: string | null, b: string | null) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

export interface MergeConflicts {
  review: boolean;
  rights: boolean;
  reviewReason: string | null;
  rightsReason: string | null;
}

/**
 * Review: a conflict when both sides have a current decision and they differ
 * (or either side already had an unresolved conflict). Same decision, or only
 * one side decided → no conflict; that decision stands.
 *
 * Rights (stricter — rights are never widened by a merge):
 *  - both sides have records with DIFFERENT statuses → conflict;
 *  - both "granted"/"own content" → conflict unless the same rights holder is recorded;
 *  - only one side has a record: a permissive one (granted/own content) → conflict
 *    (it covered one representation only); unknown/requested/denied carry over;
 *  - an unresolved conflict on either side stays a conflict.
 */
export function mergeConflicts(a: ClusterDecisionState, b: ClusterDecisionState): MergeConflicts {
  let reviewReason: string | null = null;
  // "Already used" is a fact about the content, not a judgment: it always wins, so
  // a repost on another platform can never make used content look fresh again.
  if (a.review === 'already_used' || b.review === 'already_used') reviewReason = null;
  else if (a.reviewConflict || b.reviewConflict)
    reviewReason = 'an unresolved review conflict carried over';
  else if (a.review && b.review && a.review !== b.review)
    reviewReason = `different decisions (${a.review} vs ${b.review})`;

  let rightsReason: string | null = null;
  if (a.rightsConflict || b.rightsConflict)
    rightsReason = 'an unresolved rights conflict carried over';
  else if (a.rights && b.rights) {
    if (a.rights !== b.rights)
      rightsReason = `different rights statuses (${a.rights} vs ${b.rights})`;
    else if (PERMISSIVE.has(a.rights) && !sameHolder(a.rightsHolder, b.rightsHolder))
      rightsReason = `both "${a.rights}" but not recorded for the same rights holder`;
  } else {
    const only = a.rights ?? b.rights;
    if (only && PERMISSIVE.has(only))
      rightsReason = `"${only}" was recorded for one representation only`;
  }
  return {
    review: reviewReason !== null,
    rights: rightsReason !== null,
    reviewReason,
    rightsReason,
  };
}
