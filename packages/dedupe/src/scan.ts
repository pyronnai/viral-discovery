/**
 * Bounded near-duplicate analysis.
 *
 * For each TARGET video (a bounded, scoped selection) we:
 *  1. hash its thumbnail once per thumbnail URL (safe fetch; failures are recorded
 *     as a status and detection continues without the signal);
 *  2. store its distinctive title tokens;
 *  3. generate candidates with three INDEXED blocking queries, each LIMITed —
 *     duration window, thumbnail-hash band overlap, distinctive-token overlap —
 *     so work is O(targets × K), never all pairs;
 *  4. assess each candidate pair (deterministic evidence) and record/refresh the
 *     suggestion, or auto-confirm and merge when the evidence is strong enough.
 * Human decisions (confirmed / rejected) are never overwritten or resurfaced.
 */
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { schema, type AnyDatabase } from '@vd/db';
import { DuplicateError, mergeClusters, rejectedBetween } from './merge.ts';
import { hashBands, isHash } from './phash.ts';
import {
  assessPair,
  creatorKeys,
  type DuplicateAssessment,
  type MatchProfile,
} from './similarity.ts';
import { rows, type Executor } from './state.ts';
import type { ThumbnailHasher, ThumbnailHashStatus } from './thumbnail.ts';
import { matchTokens, parseMatchTokens, tokenize } from './tokens.ts';

export interface ScanScope {
  /** Only videos never analyzed (default when nothing else is given). */
  unprocessedOnly?: boolean;
  /** Only videos first discovered within this many hours. */
  sinceHours?: number;
  platform?: string;
  videoIds?: string[];
  clusterIds?: string[];
}

export interface ScanOptions {
  scope?: ScanScope;
  /** Maximum TARGET videos (default 100). */
  limit?: number;
  /** Candidates per blocking query per target (default 40). */
  perBlock?: number;
  /** Publication/discovery window (days) for the duration and title blocks (default 120). */
  windowDays?: number;
  /** null disables thumbnail fetching (hashes already stored are still used). */
  hasher?: ThumbnailHasher | null;
  autoConfirm?: boolean;
  now?: Date;
}

export interface PairOutcome {
  targetVideoId: string;
  otherVideoId: string;
  decision: DuplicateAssessment['decision'];
  confidence: number;
  action:
    | 'suggested'
    | 'updated'
    | 'auto_confirmed'
    | 'withdrawn'
    | 'kept_decision'
    | 'skipped_rejected'
    | 'none';
  note?: string;
}

export interface ScanSummary {
  targets: number;
  thumbnails: Partial<Record<ThumbnailHashStatus, number>>;
  candidatesGenerated: number;
  comparisons: number;
  suggested: number;
  autoConfirmed: number;
  withdrawn: number;
  keptDecisions: number;
  errors: { videoId: string; message: string }[];
  pairs: PairOutcome[];
}

interface VideoRow {
  id: string;
  platform: string;
  clusterId: string | null;
  title: string | null;
  caption: string | null;
  durationMs: number | null;
  publishedAt: Date | null;
  firstDiscoveredAt: Date;
  thumbnailUrl: string | null;
  phash: string | null;
  hashUrl: string | null;
  hashStatus: string | null;
  matchTokens: string[] | null;
  handle: string | null;
  name: string | null;
}

const VIDEO_COLUMNS = sql`v.id, v.platform, v.cluster_id as "clusterId", v.title, v.caption,
  v.duration_ms as "durationMs", v.published_at as "publishedAt", v.first_discovered_at as "firstDiscoveredAt",
  v.thumbnail_url as "thumbnailUrl", v.thumbnail_phash as phash, v.thumbnail_hash_url as "hashUrl",
  v.thumbnail_hash_status as "hashStatus", v.match_tokens as "matchTokens",
  coalesce(cr.handle, v.creator_handle) as handle, coalesce(cr.display_name, v.creator_display_name) as name`;

/** Transient failures are retried on a later scan; terminal ones are remembered per URL. */
const TRANSIENT = new Set<string>(['timeout', 'fetch_failed', 'http_error']);

const textArray = (values: readonly string[]): SQL =>
  sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;

export async function selectTargets(
  db: Executor,
  options: ScanOptions,
  now: Date,
): Promise<string[]> {
  const scope = options.scope ?? {};
  const where: SQL[] = [sql`v.cluster_id is not null`];
  const explicit = Boolean(scope.videoIds?.length || scope.clusterIds?.length);
  if (scope.videoIds?.length) where.push(sql`v.id = any(${textArray(scope.videoIds)}::uuid[])`);
  if (scope.clusterIds?.length)
    where.push(sql`v.cluster_id = any(${textArray(scope.clusterIds)}::uuid[])`);
  if (scope.platform) where.push(sql`v.platform = ${scope.platform}`);
  if (scope.sinceHours !== undefined)
    where.push(
      sql`v.first_discovered_at >= ${new Date(now.getTime() - scope.sinceHours * 3_600_000)}`,
    );
  if (scope.unprocessedOnly ?? (!explicit && scope.sinceHours === undefined))
    where.push(sql`v.duplicate_scanned_at is null`);
  const result = await rows<{ id: string }>(
    db,
    sql`select v.id from videos v where ${sql.join(where, sql` and `)}
      order by v.first_discovered_at desc, v.id limit ${options.limit ?? 100}`,
  );
  return result.map((r) => r.id);
}

async function loadVideos(db: Executor, ids: string[]): Promise<VideoRow[]> {
  if (!ids.length) return [];
  return rows<VideoRow>(
    db,
    sql`select ${VIDEO_COLUMNS} from videos v left join creators cr on cr.id = v.creator_id
      where v.id = any(${textArray(ids)}::uuid[])`,
  );
}

async function references(db: Executor, ids: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (!ids.length) return map;
  // Only sightings that came from ONE specific post count (e.g. a Bluesky post
  // linking both uploads) — never shared search queries or charts.
  const refs = await rows<{ videoId: string; ref: string }>(
    db,
    sql`select distinct g.video_id as "videoId", g.context->>'postUrl' as ref from sightings g
      where g.video_id = any(${textArray(ids)}::uuid[]) and g.context ? 'postUrl'`,
  );
  for (const r of refs) map.set(r.videoId, [...(map.get(r.videoId) ?? []), r.ref]);
  return map;
}

function profile(v: VideoRow, refs: Map<string, string[]>): MatchProfile {
  return {
    videoId: v.id,
    platform: v.platform,
    durationMs: v.durationMs,
    publishedAt: v.publishedAt,
    creatorKeys: creatorKeys(v.handle, v.name),
    phash: isHash(v.phash) ? v.phash : null,
    tokens: v.matchTokens ? parseMatchTokens(v.matchTokens) : tokenize(v.title, v.caption),
    references: refs.get(v.id) ?? [],
  };
}

async function ensureThumbnailHash(
  db: Executor,
  v: VideoRow,
  hasher: ThumbnailHasher | null,
  now: Date,
  summary: ScanSummary,
): Promise<void> {
  const count = (s: ThumbnailHashStatus) => {
    summary.thumbnails[s] = (summary.thumbnails[s] ?? 0) + 1;
  };
  if (!v.thumbnailUrl) {
    if (!v.phash && v.hashStatus !== 'no_thumbnail') {
      await db
        .update(schema.videos)
        .set({ thumbnailHashStatus: 'no_thumbnail', thumbnailHashedAt: now })
        .where(eq(schema.videos.id, v.id));
    }
    count('no_thumbnail');
    return;
  }
  if (!hasher || v.hashUrl === v.thumbnailUrl) return;
  const result = await hasher(v.thumbnailUrl);
  count(result.status);
  if (result.status === 'hashed' && result.hash) {
    v.phash = result.hash;
    await db
      .update(schema.videos)
      .set({
        thumbnailPhash: result.hash,
        thumbnailHashBands: hashBands(result.hash),
        thumbnailHashStatus: 'hashed',
        thumbnailHashUrl: v.thumbnailUrl,
        thumbnailHashedAt: now,
      })
      .where(eq(schema.videos.id, v.id));
    return;
  }
  // Keep an earlier hash of the same video (e.g. a signed CDN URL rotated and the
  // new one failed); remember terminal failures per URL so they are not refetched.
  await db
    .update(schema.videos)
    .set({
      thumbnailHashStatus: result.status,
      thumbnailHashUrl: TRANSIENT.has(result.status) ? null : v.thumbnailUrl,
      thumbnailHashedAt: now,
    })
    .where(eq(schema.videos.id, v.id));
}

/**
 * Candidate generation for one target — three indexed, LIMITed blocking queries.
 * Returns other-cluster video ids (deduplicated).
 */
export async function candidateIds(
  db: Executor,
  target: VideoRow,
  tokens: string[],
  options: { perBlock: number; windowDays: number },
): Promise<string[]> {
  if (!target.clusterId) return [];
  const t = new Date(target.publishedAt ?? target.firstDiscoveredAt);
  const windowMs = options.windowDays * 86_400_000;
  const from = new Date(t.getTime() - windowMs);
  const to = new Date(t.getTime() + windowMs);
  const base = sql`v.id <> ${target.id}::uuid and v.cluster_id <> ${target.clusterId}::uuid`;
  const inWindow = sql`coalesce(v.published_at, v.first_discovered_at) between ${from} and ${to}`;
  const blocks: SQL[] = [];
  if (target.durationMs !== null && target.durationMs > 0) {
    const d = target.durationMs;
    const tol = Math.max(3_000, Math.round(d * 0.1));
    blocks.push(sql`(select v.id from videos v where ${base} and v.duration_ms between ${d - tol} and ${d + tol}
      and ${inWindow} order by abs(v.duration_ms - ${d}), v.id limit ${options.perBlock})`);
  }
  if (isHash(target.phash)) {
    // Hash search spans all time: re-uploads can appear months later.
    blocks.push(sql`(select v.id from videos v where ${base}
      and v.thumbnail_hash_bands && ${textArray(hashBands(target.phash))}
      order by v.first_discovered_at desc, v.id limit ${options.perBlock})`);
  }
  if (tokens.length) {
    const arr = textArray(tokens);
    blocks.push(sql`(select v.id from videos v where ${base} and v.match_tokens && ${arr} and ${inWindow}
      order by (select count(*) from unnest(v.match_tokens) x where x = any(${arr})) desc,
        v.first_discovered_at desc, v.id limit ${options.perBlock})`);
  }
  if (!blocks.length) return [];
  const result = await rows<{ id: string }>(db, sql.join(blocks, sql` union `));
  return [...new Set(result.map((r) => r.id))];
}

async function clusterOf(db: Executor, videoId: string): Promise<string | null> {
  const [row] = await db
    .select({ clusterId: schema.videos.clusterId })
    .from(schema.videos)
    .where(eq(schema.videos.id, videoId));
  return row?.clusterId ?? null;
}

async function hasHumanDecisions(db: Executor, clusterId: string): Promise<boolean> {
  const [row] = await rows<{ n: number }>(
    db,
    sql`select ((select count(*) from review_events where cluster_id = ${clusterId}::uuid)
      + (select count(*) from rights where cluster_id = ${clusterId}::uuid))::int as n`,
  );
  return (row?.n ?? 0) > 0;
}

const ordered = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);

async function applyAssessment(
  db: AnyDatabase,
  targetId: string,
  otherId: string,
  assessment: DuplicateAssessment,
  options: { autoConfirm: boolean; now: Date },
): Promise<PairOutcome> {
  const [a, b] = ordered(targetId, otherId);
  const outcome = (action: PairOutcome['action'], note?: string): PairOutcome => ({
    targetVideoId: targetId,
    otherVideoId: otherId,
    decision: assessment.decision,
    confidence: assessment.confidence,
    action,
    ...(note ? { note } : {}),
  });
  const [existing] = await db
    .select()
    .from(schema.duplicateCandidates)
    .where(
      and(eq(schema.duplicateCandidates.videoAId, a), eq(schema.duplicateCandidates.videoBId, b)),
    );
  if (existing && existing.status !== 'possible') return outcome('kept_decision', existing.status);

  const [clusterA, clusterB] = [await clusterOf(db, a), await clusterOf(db, b)];
  if (!clusterA || !clusterB || clusterA === clusterB)
    return outcome('none', 'already in the same cluster');
  if ((await rejectedBetween(db, clusterA, clusterB)).length) {
    return outcome('skipped_rejected', 'a human already marked these clusters as different');
  }

  if (assessment.decision === 'no_match') {
    if (existing) {
      // A machine suggestion whose evidence no longer holds is withdrawn (no human input is lost).
      await db
        .delete(schema.duplicateCandidates)
        .where(eq(schema.duplicateCandidates.id, existing.id));
      return outcome('withdrawn');
    }
    return outcome('none');
  }

  const reasons = [...assessment.reasons];
  let auto = assessment.decision === 'auto_confirm' && options.autoConfirm;
  if (auto && (await hasHumanDecisions(db, clusterA)) && (await hasHumanDecisions(db, clusterB))) {
    // Both sides carry human review/rights history: merging could create conflicts, so a human decides.
    auto = false;
    reasons.push('AUTO_BLOCKED_BOTH_SIDES_REVIEWED');
  }
  if (assessment.decision === 'auto_confirm' && !options.autoConfirm)
    reasons.push('AUTO_CONFIRM_DISABLED');

  const values = {
    confidence: assessment.confidence,
    evidence: {
      ...assessment.evidence,
      score: assessment.score,
      positiveSignals: assessment.positiveSignals,
    },
    reasons,
    detectorVersion: assessment.detectorVersion,
    lastEvaluatedAt: options.now,
  };
  const saved = existing
    ? (
        await db
          .update(schema.duplicateCandidates)
          .set(values)
          .where(eq(schema.duplicateCandidates.id, existing.id))
          .returning()
      )[0]
    : (
        await db
          .insert(schema.duplicateCandidates)
          .values({
            videoAId: a,
            videoBId: b,
            status: 'possible',
            firstDetectedAt: options.now,
            ...values,
          })
          .returning()
      )[0];
  if (!saved) throw new DuplicateError('duplicate candidate was not saved');
  if (!auto) return outcome(existing ? 'updated' : 'suggested');

  await db.transaction(async (tx) => {
    await mergeClusters(tx, {
      clusterIds: [clusterA, clusterB],
      candidateId: saved.id,
      trigger: 'auto',
      now: options.now,
    });
    await tx
      .update(schema.duplicateCandidates)
      .set({ status: 'auto_confirmed', decidedAt: options.now, decidedBy: 'detector' })
      .where(eq(schema.duplicateCandidates.id, saved.id));
  });
  return outcome('auto_confirmed');
}

export async function scanDuplicates(
  db: AnyDatabase,
  options: ScanOptions = {},
): Promise<ScanSummary> {
  const now = options.now ?? new Date();
  const perBlock = options.perBlock ?? 40;
  const windowDays = options.windowDays ?? 120;
  const hasher = options.hasher === undefined ? null : options.hasher;
  const summary: ScanSummary = {
    targets: 0,
    thumbnails: {},
    candidatesGenerated: 0,
    comparisons: 0,
    suggested: 0,
    autoConfirmed: 0,
    withdrawn: 0,
    keptDecisions: 0,
    errors: [],
    pairs: [],
  };
  const targets = await selectTargets(db, options, now);
  summary.targets = targets.length;
  // Phase 1: fingerprint every target first, so targets in the same batch can find each other.
  const prepared = new Set<string>();
  for (const target of await loadVideos(db, targets)) {
    try {
      await ensureThumbnailHash(db, target, hasher, now, summary);
      await db
        .update(schema.videos)
        .set({ matchTokens: matchTokens(tokenize(target.title, target.caption)) })
        .where(eq(schema.videos.id, target.id));
      prepared.add(target.id);
    } catch (err) {
      summary.errors.push({
        videoId: target.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Phase 2: candidate generation + assessment.
  for (const targetId of targets) {
    if (!prepared.has(targetId)) continue;
    try {
      const [target] = await loadVideos(db, [targetId]);
      if (!target) continue;
      const tokens = tokenize(target.title, target.caption);
      const ids = await candidateIds(db, target, tokens.words, { perBlock, windowDays });
      summary.candidatesGenerated += ids.length;
      const others = await loadVideos(db, ids);
      const refs = await references(db, [target.id, ...ids]);
      const mine = profile(target, refs);
      for (const other of others) {
        summary.comparisons++;
        const outcome = await applyAssessment(
          db,
          target.id,
          other.id,
          assessPair(mine, profile(other, refs)),
          {
            autoConfirm: options.autoConfirm ?? true,
            now,
          },
        );
        summary.pairs.push(outcome);
        if (outcome.action === 'suggested') summary.suggested++;
        if (outcome.action === 'auto_confirmed') summary.autoConfirmed++;
        if (outcome.action === 'withdrawn') summary.withdrawn++;
        if (outcome.action === 'kept_decision') summary.keptDecisions++;
      }
      await db
        .update(schema.videos)
        .set({ duplicateScannedAt: now })
        .where(eq(schema.videos.id, target.id));
    } catch (err) {
      summary.errors.push({
        videoId: targetId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return summary;
}

/** Evidence for one explicit pair (CLI `duplicates explain`), without storing anything. */
export async function explainPair(
  db: Executor,
  videoA: string,
  videoB: string,
): Promise<DuplicateAssessment | null> {
  const videos = await loadVideos(db, [videoA, videoB]);
  const a = videos.find((v) => v.id === videoA);
  const b = videos.find((v) => v.id === videoB);
  if (!a || !b) return null;
  const refs = await references(db, [a.id, b.id]);
  return assessPair(profile(a, refs), profile(b, refs));
}
