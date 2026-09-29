'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { classifyCluster } from '@vd/pipeline';
import { ReviewError, recordReview, setRights } from '@vd/review';
import { ACCESS_COOKIE, safeNext, sha256Hex, tokenMatches } from '../lib/access.ts';
import { getContext } from '../lib/server.ts';

export type ActionResult =
  { ok: true; status?: string; message?: string } | { ok: false; error: string };

function failure(err: unknown, fallback: string): ActionResult {
  if (err instanceof ReviewError) return { ok: false, error: err.message };
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
