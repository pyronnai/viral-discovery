/**
 * Refresh ladder: after a video enters the system (T0 = its first canonical
 * snapshot, else first discovery), re-read metrics at T0 + each step, then stop.
 * The ladder is data (sources.config.refreshPolicy, CLI flags), not code.
 */
import { and, eq, gte, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@vd/db';
import type { PipelineDeps } from './ingest.ts';
import { refreshMetrics, refreshAdapter, type RefreshSummary } from './refresh.ts';
import { ensureSource } from './sources.ts';

export const RefreshPolicySchema = z.object({
  /** Minutes after T0 at which to refresh (ascending). */
  ladderMinutes: z.array(z.number().int().positive()).min(1).default([120, 480, 1_440, 4_320]),
  /** A snapshot counts for a step if taken at or after step × (1 − tolerance). */
  tolerance: z.number().min(0).max(0.9).default(0.2),
  /** After the last step + this grace, the video ages out (no more refreshes). */
  graceMinutes: z.number().int().min(0).default(360),
});
export type RefreshPolicy = z.infer<typeof RefreshPolicySchema>;
export const DEFAULT_REFRESH_POLICY: RefreshPolicy = RefreshPolicySchema.parse({});

/** "2h,8h,24h,72h" or "120,480" (minutes) → minutes. */
export function parseLadder(value: string): number[] {
  return value.split(',').map((part) => {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(m|h|d)?\s*$/i.exec(part);
    if (!m) throw new Error(`invalid ladder step "${part}" (use e.g. 2h, 90m, 3d)`);
    const n = Number(m[1]);
    const unit = (m[2] ?? 'm').toLowerCase();
    const minutes = Math.round(unit === 'd' ? n * 1_440 : unit === 'h' ? n * 60 : n);
    if (minutes <= 0) throw new Error(`ladder step must be positive: "${part}"`);
    return minutes;
  });
}

export type LadderStatus =
  | { due: true; step: number; stepAt: Date }
  | { due: false; reason: 'waiting' | 'step_satisfied' | 'aged_out'; nextAt: Date | null };

/** Pure decision for one video. */
export function ladderStatus(
  t0: Date,
  snapshotTimes: readonly Date[],
  now: Date,
  policy: RefreshPolicy,
): LadderStatus {
  const steps = [...policy.ladderMinutes].sort((a, b) => a - b);
  const last = steps[steps.length - 1] ?? 0;
  const base = t0.getTime();
  const nowMs = now.getTime();
  if (nowMs > base + (last + policy.graceMinutes) * 60_000) {
    return { due: false, reason: 'aged_out', nextAt: null };
  }
  const latest = Math.max(...snapshotTimes.map((d) => d.getTime()), Number.NEGATIVE_INFINITY);
  let current = -1;
  steps.forEach((minutes, i) => {
    if (base + minutes * 60_000 <= nowMs) current = i;
  });
  const next = steps[current + 1];
  const nextAt = next === undefined ? null : new Date(base + next * 60_000);
  if (current < 0) return { due: false, reason: 'waiting', nextAt };
  const stepMinutes = steps[current] ?? 0;
  const satisfiedFrom = base + stepMinutes * (1 - policy.tolerance) * 60_000;
  if (latest >= satisfiedFrom) return { due: false, reason: 'step_satisfied', nextAt };
  return { due: true, step: current + 1, stepAt: new Date(base + stepMinutes * 60_000) };
}

/** Merges the refreshing source's `config.refreshPolicy` (if any) over the defaults and overrides. */
export function resolvePolicy(
  sourceConfig: Record<string, unknown>,
  override?: Partial<RefreshPolicy>,
) {
  const fromSource = RefreshPolicySchema.partial().safeParse(sourceConfig['refreshPolicy'] ?? {});
  return RefreshPolicySchema.parse({ ...(fromSource.success ? fromSource.data : {}), ...override });
}

export interface DueSummary extends RefreshSummary {
  platform: string;
  policy: RefreshPolicy;
  considered: number;
  due: number;
  agedOut: number;
}

/**
 * Refreshes only the videos of `platform` whose next ladder step is due, in one
 * bulk call through the platform's adapter (e.g. YouTube batchGetStats).
 */
export async function refreshDue(
  deps: PipelineDeps,
  options: { platform: string; limit: number; policy?: Partial<RefreshPolicy> },
): Promise<DueSummary> {
  const now = (deps.now ?? (() => new Date()))();
  const adapter = refreshAdapter(deps, options.platform);
  const source = await ensureSource(deps.db, adapter.manifest);
  const policy = resolvePolicy(source.config, options.policy);
  const horizonMinutes = Math.max(...policy.ladderMinutes) + policy.graceMinutes;
  const since = new Date(now.getTime() - horizonMinutes * 60_000);

  // Candidates: discovered recently enough that a ladder step could still apply.
  const videos = await deps.db
    .select({ id: schema.videos.id, firstDiscoveredAt: schema.videos.firstDiscoveredAt })
    .from(schema.videos)
    .where(
      and(
        eq(schema.videos.platform, options.platform),
        gte(schema.videos.firstDiscoveredAt, since),
      ),
    );
  const times = new Map<string, Date[]>();
  if (videos.length > 0) {
    const rows = await deps.db
      .select({
        videoId: schema.metricSnapshots.videoId,
        capturedAt: schema.metricSnapshots.capturedAt,
      })
      .from(schema.metricSnapshots)
      .where(
        inArray(
          schema.metricSnapshots.videoId,
          videos.map((v) => v.id),
        ),
      );
    for (const r of rows) times.set(r.videoId, [...(times.get(r.videoId) ?? []), r.capturedAt]);
  }

  let agedOut = 0;
  const due: { id: string; stepAt: number }[] = [];
  for (const v of videos) {
    const snaps = times.get(v.id) ?? [];
    const t0 = snaps.length
      ? new Date(Math.min(...snaps.map((d) => d.getTime())))
      : v.firstDiscoveredAt;
    const status = ladderStatus(t0, snaps, now, policy);
    if (status.due) due.push({ id: v.id, stepAt: status.stepAt.getTime() });
    else if (status.reason === 'aged_out') agedOut += 1;
  }
  // Most overdue first.
  due.sort((a, b) => a.stepAt - b.stepAt || a.id.localeCompare(b.id));
  const selected = due.slice(0, options.limit).map((d) => d.id);
  const summary =
    selected.length > 0
      ? await refreshMetrics(deps, {
          platform: options.platform,
          limit: selected.length,
          videoIds: selected,
        })
      : {
          adapterId: adapter.manifest.id,
          requested: 0,
          snapshotsCreated: 0,
          unavailable: 0,
          invalid: [],
          error: null,
          quotaUsed: {},
        };
  return {
    ...summary,
    platform: options.platform,
    policy,
    considered: videos.length,
    due: due.length,
    agedOut,
  };
}
