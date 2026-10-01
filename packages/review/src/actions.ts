/**
 * Human decisions. Both are append-only histories on the CLUSTER:
 * - review_events: approved | rejected | saved | already_used (latest = current)
 * - rights:        unknown | requested | granted | denied | own_content (latest = current)
 * They are independent: "approved" never implies rights clearance, and nothing
 * here publishes or contacts anyone.
 *
 * After a cluster merge with conflicting histories, the next decision recorded
 * here resolves the conflict (so it is always appended, even if it repeats the
 * latest carried-over record).
 */
import { and, desc, eq } from 'drizzle-orm';
import { REVIEW_STATUSES, RIGHTS_STATUSES, type ReviewStatus, type RightsStatus } from '@vd/core';
import { schema, type AnyDatabase } from '@vd/db';
import { clusterDecisionState } from '@vd/dedupe';

export class ReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewError';
  }
}

async function assertCluster(db: AnyDatabase, clusterId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(clusterId)) throw new ReviewError('invalid candidate id');
  const [c] = await db
    .select({ id: schema.clusters.id, mergedInto: schema.clusters.mergedIntoClusterId })
    .from(schema.clusters)
    .where(eq(schema.clusters.id, clusterId));
  if (!c) throw new ReviewError('candidate not found');
  // Decisions belong on the surviving cluster, never on a merged-away one.
  if (c.mergedInto)
    throw new ReviewError('this candidate was merged into another; reload the page');
}

function cleanNote(note: string | null | undefined): string | null {
  const t = note?.trim();
  if (!t) return null;
  if (t.length > 500) throw new ReviewError('note is limited to 500 characters');
  return t;
}

export interface ReviewInput {
  clusterId: string;
  status: string;
  note?: string | null;
  reviewer?: string;
  now?: Date;
}

/**
 * Appends a review event. Idempotent: repeating the current status with the same
 * note returns the existing event instead of adding a duplicate.
 */
export async function recordReview(db: AnyDatabase, input: ReviewInput) {
  if (!(REVIEW_STATUSES as readonly string[]).includes(input.status)) {
    throw new ReviewError(`unknown review status "${input.status}"`);
  }
  const status = input.status as ReviewStatus;
  const note = cleanNote(input.note);
  await assertCluster(db, input.clusterId);
  const [latest] = await db
    .select()
    .from(schema.reviewEvents)
    .where(eq(schema.reviewEvents.clusterId, input.clusterId))
    .orderBy(desc(schema.reviewEvents.createdAt), desc(schema.reviewEvents.id))
    .limit(1);
  const { reviewConflict } = await clusterDecisionState(db, input.clusterId);
  if (!reviewConflict && latest && latest.status === status && latest.note === note)
    return { event: latest, created: false };
  const [event] = await db
    .insert(schema.reviewEvents)
    .values({
      clusterId: input.clusterId,
      status,
      note,
      reviewer: input.reviewer ?? 'owner',
      createdAt: input.now ?? new Date(),
    })
    .returning();
  if (!event) throw new ReviewError('review was not saved');
  return { event, created: true };
}

export interface RightsInput {
  clusterId: string;
  status: string;
  rightsHolder?: string | null;
  evidenceUrl?: string | null;
  notes?: string | null;
  now?: Date;
}

/** Appends a rights record (history kept). Idempotent for an unchanged record. */
export async function setRights(db: AnyDatabase, input: RightsInput) {
  if (!(RIGHTS_STATUSES as readonly string[]).includes(input.status)) {
    throw new ReviewError(`unknown rights status "${input.status}"`);
  }
  const status = input.status as RightsStatus;
  const notes = cleanNote(input.notes);
  const rightsHolder = input.rightsHolder?.trim() || null;
  let evidenceUrl: string | null = input.evidenceUrl?.trim() || null;
  if (evidenceUrl) {
    try {
      const u = new URL(evidenceUrl);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
      evidenceUrl = u.href;
    } catch {
      throw new ReviewError('evidence URL must be an http(s) URL');
    }
  }
  await assertCluster(db, input.clusterId);
  const [latest] = await db
    .select()
    .from(schema.rights)
    .where(and(eq(schema.rights.clusterId, input.clusterId)))
    .orderBy(desc(schema.rights.createdAt), desc(schema.rights.id))
    .limit(1);
  const { rightsConflict } = await clusterDecisionState(db, input.clusterId);
  if (
    !rightsConflict &&
    latest &&
    latest.status === status &&
    latest.notes === notes &&
    latest.rightsHolder === rightsHolder &&
    latest.evidenceUrl === evidenceUrl
  ) {
    return { record: latest, created: false };
  }
  const now = input.now ?? new Date();
  const [record] = await db
    .insert(schema.rights)
    .values({
      clusterId: input.clusterId,
      status,
      notes,
      rightsHolder,
      evidenceUrl,
      decidedAt: status === 'granted' || status === 'denied' ? now : null,
      requestedAt: status === 'requested' ? now : null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!record) throw new ReviewError('rights were not saved');
  return { record, created: true };
}
