/**
 * Metadata/link export for handing selected candidates to an external editing
 * workflow. One row per underlying clip (cluster); confirmed alternate
 * representations are listed as extra source links. Never media files.
 */
import { sql } from 'drizzle-orm';
import type { AnyDatabase } from '@vd/db';
import { resolveCluster } from '@vd/dedupe';
import { baseQuery, getFeed, rows, type FeedFilters, type FeedRow } from './feed.ts';
import { platformName, REVIEW_LABELS, RIGHTS_LABELS } from './present.ts';

export const MAX_EXPORT = 500;

export interface ExportRow {
  clusterId: string;
  title: string;
  creator: string | null;
  creatorHandle: string | null;
  platform: string;
  canonicalUrl: string;
  alternates: { platform: string; url: string }[];
  viralityScore: number | null;
  scoreState: string;
  labels: string[];
  /** Moderation labels reported by the source platform (not AI), e.g. "bluesky:porn". */
  platformLabels: string[];
  durationSeconds: number | null;
  publishedAt: string | null;
  views: number | null;
  rights: string;
  review: string;
  obtained: boolean;
  obtainedAt: string | null;
  obtainedNote: string | null;
  possibleDuplicates: number;
  /** Always true: every candidate has a canonical source link. */
  sourceLinkAvailable: true;
  /** True only when an official/authorized downloadable asset is recorded. */
  mediaDownloadAvailable: boolean;
}

export function toExportRow(r: FeedRow): ExportRow {
  return {
    clusterId: r.clusterId,
    title: r.title ?? r.caption?.slice(0, 140) ?? '(untitled)',
    creator: r.creatorName,
    creatorHandle: r.creatorHandle,
    platform: platformName(r.platform),
    canonicalUrl: r.canonicalUrl,
    alternates: r.representations
      .filter((x) => x.videoId !== r.videoId)
      .map((x) => ({ platform: platformName(x.platform), url: x.url })),
    viralityScore: r.score === null ? null : Math.round(r.score * 10) / 10,
    scoreState: r.scoreState ?? 'unscored',
    labels: (r.labels ?? []).map((l) => l.label),
    platformLabels: [...new Set(r.sourceModeration.map((l) => `${l.platform}:${l.value}`))].sort(),
    durationSeconds: r.durationMs === null ? null : Math.round(r.durationMs / 1000),
    publishedAt: r.publishedAt ? new Date(r.publishedAt).toISOString() : null,
    views: r.views,
    rights: RIGHTS_LABELS[r.rightsStatus] ?? r.rightsStatus,
    review: r.reviewConflict
      ? 'Review conflict'
      : r.reviewStatus
        ? (REVIEW_LABELS[r.reviewStatus] ?? r.reviewStatus)
        : 'Unreviewed',
    obtained: r.acquisitionStatus === 'obtained',
    obtainedAt: r.obtainedAt ? new Date(r.obtainedAt).toISOString() : null,
    obtainedNote: r.acquisitionStatus === 'obtained' ? r.acquisitionNote : null,
    possibleDuplicates: r.possibleDuplicates,
    sourceLinkAvailable: true,
    mediaDownloadAvailable: r.mediaDownloadAvailable,
  };
}

/**
 * Rows for explicit cluster ids (merged-away ids resolve to their survivor, and a
 * clip selected twice appears once), or for a feed filter (e.g. the Saved view).
 */
export async function getExportRows(
  db: AnyDatabase,
  input: { clusterIds: string[] } | { filters: FeedFilters; now?: Date },
): Promise<ExportRow[]> {
  if ('clusterIds' in input) {
    const resolved: string[] = [];
    for (const id of input.clusterIds.slice(0, MAX_EXPORT)) {
      const r = await resolveCluster(db, id);
      if (r && !resolved.includes(r)) resolved.push(r);
    }
    if (!resolved.length) return [];
    const found = await rows<FeedRow>(
      db,
      sql`select * from (${baseQuery()}) f where f."clusterId" = any(ARRAY[${sql.join(
        resolved.map((id) => sql`${id}`),
        sql`, `,
      )}]::uuid[])`,
    );
    // Keep the caller's selection order.
    return resolved.flatMap((id) => {
      const row = found.find((f) => f.clusterId === id);
      return row ? [toExportRow(row)] : [];
    });
  }
  const out: ExportRow[] = [];
  let cursor: string | null = null;
  do {
    const page = await getFeed(db, {
      filters: input.filters,
      cursor,
      pageSize: 100,
      ...(input.now ? { now: input.now } : {}),
    });
    out.push(...page.items.map(toExportRow));
    cursor = page.nextCursor;
  } while (cursor && out.length < MAX_EXPORT);
  return out.slice(0, MAX_EXPORT);
}

const CSV_COLUMNS: [string, (r: ExportRow) => string | number | boolean | null][] = [
  ['title', (r) => r.title],
  ['creator', (r) => r.creator],
  ['creator_handle', (r) => r.creatorHandle],
  ['platform', (r) => r.platform],
  ['canonical_url', (r) => r.canonicalUrl],
  ['alternate_urls', (r) => r.alternates.map((a) => `${a.platform}: ${a.url}`).join(' | ')],
  ['virality_score', (r) => r.viralityScore],
  ['score_state', (r) => r.scoreState],
  ['labels', (r) => r.labels.join(', ')],
  ['platform_labels', (r) => r.platformLabels.join(', ')],
  ['duration_seconds', (r) => r.durationSeconds],
  ['published_at', (r) => r.publishedAt],
  ['views', (r) => r.views],
  ['rights', (r) => r.rights],
  ['review', (r) => r.review],
  ['obtained', (r) => r.obtained],
  ['obtained_at', (r) => r.obtainedAt],
  ['obtained_note', (r) => r.obtainedNote],
  ['possible_duplicates', (r) => r.possibleDuplicates],
  ['media_download_available', (r) => r.mediaDownloadAvailable],
  ['cluster_id', (r) => r.clusterId],
];

/** RFC 4180 quoting, plus a guard against spreadsheet formula injection. */
export function csvCell(value: string | number | boolean | null): string {
  if (value === null) return '';
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rowsToWrite: ExportRow[]): string {
  const lines = [CSV_COLUMNS.map(([name]) => name).join(',')];
  for (const r of rowsToWrite) lines.push(CSV_COLUMNS.map(([, get]) => csvCell(get(r))).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

export function toJson(rowsToWrite: ExportRow[], exportedAt: Date): string {
  return JSON.stringify(
    {
      exportedAt: exportedAt.toISOString(),
      note: 'Metadata and source links only. No media files. Rights "Unknown" is not permission.',
      count: rowsToWrite.length,
      candidates: rowsToWrite,
    },
    null,
    2,
  );
}
