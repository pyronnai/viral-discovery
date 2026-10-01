'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { DuplicateError, confirmDuplicate, rejectDuplicate } from '@vd/dedupe';
import { classifyCluster } from '@vd/pipeline';
import {
  ReviewError,
  bulkApply,
  recordAcquisition,
  recordReview,
  setRights,
  setSaved,
  type BulkResult,
} from '@vd/review';
import { ACCESS_COOKIE, safeNext, sha256Hex, tokenMatches } from '../lib/access.ts';
import { getContext } from '../lib/server.ts';

export type ActionResult =
  | { ok: true; status?: string; message?: string; redirectTo?: string }
  | { ok: false; error: string };

function failure(err: unknown, fallback: string): ActionResult {
  if (err instanceof ReviewError || err instanceof DuplicateError)
    return { ok: false, error: err.message };
  getContext().logger.error({ err }, fallback);
  return { ok: false, error: fallback };
}

/** Appends a review event for the cluster (approve/reject/save/already used). */
export async function reviewAction(
  clusterId: string,
  status: string,
  note?: string,
): Promise<ActionResult> {
  try {
    const r = await recordReview(getContext().db, { clusterId, status, note: note ?? null });
    revalidatePath('/');
    revalidatePath(`/candidates/${clusterId}`);
    return { ok: true, status: r.event.status };
  } catch (err) {
    return failure(err, 'could not save the review decision');
  }
}

function refresh(clusterId?: string) {
  revalidatePath('/');
  if (clusterId) revalidatePath(`/candidates/${clusterId}`);
}

/** Save (shortlist) / Unsave. Unsave never undoes "already used" or "rejected". */
export async function savedAction(clusterId: string, saved: boolean): Promise<ActionResult> {
  try {
    await setSaved(getContext().db, { clusterId, saved });
    refresh(clusterId);
    return { ok: true, status: saved ? 'saved' : 'unsaved' };
  } catch (err) {
    return failure(err, 'could not update saved');
  }
}

/** Obtained (media obtained externally — tracking only) / not obtained. Never marks "used". */
export async function obtainedAction(
  clusterId: string,
  obtained: boolean,
  note?: string,
  videoId?: string,
): Promise<ActionResult> {
  try {
    await recordAcquisition(getContext().db, {
      clusterId,
      status: obtained ? 'obtained' : 'not_obtained',
      note: note ?? null,
      videoId: videoId ?? null,
    });
    refresh(clusterId);
    return { ok: true, status: obtained ? 'obtained' : 'not_obtained' };
  } catch (err) {
    return failure(err, 'could not update obtained');
  }
}

/** Bulk save / obtained / used / reject (the UI confirms broad actions first). */
export async function bulkAction(
  clusterIds: string[],
  action: string,
): Promise<{ ok: true; result: BulkResult } | { ok: false; error: string }> {
  try {
    const result = await bulkApply(getContext().db, { clusterIds, action });
    refresh();
    return { ok: true, result };
  } catch (err) {
    const f = failure(err, 'bulk action failed');
    return f.ok ? { ok: false, error: 'bulk action failed' } : f;
  }
}

/** Appends a rights record. Separate from review: approval never implies rights. */
export async function rightsAction(clusterId: string, form: FormData): Promise<ActionResult> {
  const text = (key: string) => {
    const v = form.get(key);
    return typeof v === 'string' ? v : null;
  };
  try {
    await setRights(getContext().db, {
      clusterId,
      status: text('status') ?? '',
      rightsHolder: text('rightsHolder'),
      evidenceUrl: text('evidenceUrl'),
      notes: text('notes'),
    });
    revalidatePath(`/candidates/${clusterId}`);
    revalidatePath('/');
    return { ok: true };
  } catch (err) {
    return failure(err, 'could not save rights');
  }
}

/** Manual Classify / Reclassify. Fails clearly when no classifier is configured. */
export async function classifyAction(clusterId: string, force: boolean): Promise<ActionResult> {
  const ctx = getContext();
  if (!ctx.classifier.configured) return { ok: false, error: ctx.classifier.reason };
  try {
    const r = await classifyCluster(ctx.pipeline(), clusterId, {
      classifier: ctx.classifier.classifier,
      force,
    });
    revalidatePath(`/candidates/${clusterId}`);
    revalidatePath('/');
    if (r.status === 'failed')
      return { ok: false, error: `classification failed: ${r.error?.kind ?? 'error'}` };
    return {
      ok: true,
      message: r.status === 'unchanged' ? 'already classified for these inputs' : 'classified',
    };
  } catch (err) {
    return failure(err, 'classification failed');
  }
}

/** CONFIRM SAME VIDEO: merges the two clusters (nothing is deleted; conflicts are surfaced). */
export async function confirmDuplicateAction(
  candidateId: string,
  clusterId: string,
): Promise<ActionResult> {
  try {
    const r = await confirmDuplicate(getContext().db, candidateId);
    const target = r.merge?.survivorClusterId ?? clusterId;
    revalidatePath('/');
    revalidatePath(`/candidates/${clusterId}`);
    revalidatePath(`/candidates/${target}`);
    return {
      ok: true,
      message:
        r.merge?.reviewConflict || r.merge?.rightsConflict
          ? 'merged — conflict needs review'
          : 'merged',
      redirectTo: `/candidates/${target}`,
    };
  } catch (err) {
    return failure(err, 'could not confirm the duplicate');
  }
}

/** NOT THE SAME: remembered; never suggested again for these two clusters. */
export async function rejectDuplicateAction(
  candidateId: string,
  clusterId: string,
): Promise<ActionResult> {
  try {
    await rejectDuplicate(getContext().db, candidateId);
    revalidatePath('/');
    revalidatePath(`/candidates/${clusterId}`);
    return { ok: true, message: 'marked not the same' };
  } catch (err) {
    return failure(err, 'could not reject the duplicate');
  }
}

export async function loginAction(form: FormData): Promise<void> {
  const token = getContext().config.DASHBOARD_ACCESS_TOKEN;
  const submitted = form.get('token');
  const next = safeNext(typeof form.get('next') === 'string' ? (form.get('next') as string) : '/');
  if (!token) redirect(next);
  if (typeof submitted !== 'string' || !(await tokenMatches(submitted, token))) {
    redirect(`/login?error=1&next=${encodeURIComponent(next)}`);
  }
  (await cookies()).set(ACCESS_COOKIE, await sha256Hex(token), {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
  redirect(next);
}
