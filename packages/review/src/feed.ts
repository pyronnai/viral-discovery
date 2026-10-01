/**
 * The review feed: one row per CLUSTER (its representative video), with only the
 * summary data a card needs. Heavy data (all snapshots, all sightings, histories)
 * is loaded by the detail page instead. One query per page — no N+1.
 *
 * Ranking: scored → provisional → insufficient evidence → unscored; then latest
 * virality score (NULL is never treated as zero — it sorts within its own state);
 * then recency (published, else first discovered); then cluster id.
 * Pagination is keyset (cursor) on exactly that order.
 */
import { sql, type SQL } from 'drizzle-orm';
import { PROMPT_VERSION, TAXONOMY_VERSION } from '@vd/classification';
import type { AnyDatabase } from '@vd/db';
import { DEFAULT_SCORING_CONFIG } from '@vd/scoring';

export interface SourceCount {
  source: string;
  adapterId: string;
  observations: number;
}

export interface FeedRow {
  clusterId: string;
  videoId: string;
  platform: string;
  platformVideoId: string;
  canonicalUrl: string;
  title: string | null;
  caption: string | null;
  thumbnailUrl: string | null;
  durationMs: number | null;
  publishedAt: Date | null;
  firstDiscoveredAt: Date;
  availability: string;
  creatorName: string | null;
  creatorHandle: string | null;
  score: number | null;
  scoreState: 'scored' | 'provisional' | 'insufficient_evidence' | null;
  confidence: number | null;
  scoreComponents: Record<string, unknown> | null;
  reasonCodes: string[] | null;
  scoredAt: Date | null;
  /** NULL while a merge review conflict is unresolved (see reviewConflict). */
  reviewStatus: 'approved' | 'rejected' | 'saved' | 'already_used' | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  /** 'conflict' while a merge rights conflict is unresolved. */
  rightsStatus: string;
  reviewConflict: boolean;
  rightsConflict: boolean;
  /** Other clusters suggested as possible duplicates (not yet decided). */
  possibleDuplicates: number;
  /** Platforms of the versions in this cluster. */
  platforms: string[];
  labels: { label: string; confidence: number }[] | null;
  safetyFlags: { flag: string; confidence: number; note: string }[] | null;
  aiSummary: string | null;
  classifiedAt: Date | null;
  classificationFailure: string | null;
  classificationFailedAt: Date | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  metricsAt: Date | null;
  versions: number;
  sources: SourceCount[];
  stateRank: number;
  sortTime: Date;
}

export const REVIEW_FILTERS = [
  'unreviewed',
  'conflict',
  'approved',
  'rejected',
  'saved',
  'already_used',
] as const;
export const STATE_FILTERS = [
  'scored',
  'provisional',
  'insufficient_evidence',
  'unscored',
] as const;

export interface FeedFilters {
  review?: (typeof REVIEW_FILTERS)[number] | undefined;
  label?: string | undefined;
  platform?: string | undefined;
  source?: string | undefined;
  state?: (typeof STATE_FILTERS)[number] | undefined;
  minScore?: number | undefined;
  discoveredWithinHours?: number | undefined;
  rights?: string | undefined;
  flagged?: boolean | undefined;
  possibleDuplicates?: boolean | undefined;
}

interface Cursor {
  r: number;
  s: number;
  t: string;
  id: string;
}

export function encodeCursor(
  row: Pick<FeedRow, 'stateRank' | 'score' | 'sortTime' | 'clusterId'>,
): string {
  const c: Cursor = {
    r: row.stateRank,
    s: row.score ?? -1,
    t: new Date(row.sortTime).toISOString(),
    id: row.clusterId,
  };
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

export function decodeCursor(value: string | undefined | null): Cursor | null {
  if (!value) return null;
  try {
    const c = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (
      typeof c.r === 'number' &&
      typeof c.s === 'number' &&
      typeof c.t === 'string' &&
      !Number.isNaN(Date.parse(c.t)) &&
      typeof c.id === 'string' &&
      /^[0-9a-f-]{36}$/i.test(c.id)
    ) {
      return { r: c.r, s: c.s, t: c.t, id: c.id };
    }
  } catch {
    // fall through
  }
  return null;
}

export async function rows<T>(db: AnyDatabase, query: SQL): Promise<T[]> {
  const result = (await db.execute(query)) as { rows: T[] };
  return result.rows;
}

/**
 * A merge conflict is open while no decision was recorded after the latest
 * conflicting merge. Until then the cluster has no effective review / rights status.
 */
const REVIEW_CONFLICT = sql.raw(
  `(mc.review_at is not null and (rv.created_at is null or rv.created_at <= mc.review_at))`,
);
const RIGHTS_CONFLICT = sql.raw(
  `(mc.rights_at is not null and (rt.created_at is null or rt.created_at <= mc.rights_at))`,
);

/**
 * The per-cluster summary relation shared by the feed, summary counts, and detail.
 * Clusters merged into another are excluded (their videos and history live on the survivor).
 */
export function baseQuery(): SQL {
  const scoreVersion = DEFAULT_SCORING_CONFIG.version;
  return sql`
    select
      c.id as "clusterId",
      v.id as "videoId", v.platform, v.platform_video_id as "platformVideoId",
      v.canonical_url as "canonicalUrl", v.title, v.caption, v.thumbnail_url as "thumbnailUrl",
      v.duration_ms as "durationMs", v.published_at as "publishedAt",
      v.first_discovered_at as "firstDiscoveredAt", v.availability::text as availability,
      coalesce(cr.display_name, v.creator_display_name) as "creatorName",
      coalesce(cr.handle, v.creator_handle) as "creatorHandle",
      s.value as score, s.state::text as "scoreState", s.confidence,
      s.components as "scoreComponents", s.reason_codes as "reasonCodes", s.computed_at as "scoredAt",
      case when ${REVIEW_CONFLICT} then null else rv.status::text end as "reviewStatus",
      rv.created_at as "reviewedAt", rv.note as "reviewNote",
      case when ${RIGHTS_CONFLICT} then 'conflict' else coalesce(rt.status::text, 'unknown') end as "rightsStatus",
      ${REVIEW_CONFLICT} as "reviewConflict", ${RIGHTS_CONFLICT} as "rightsConflict",
      (select count(distinct case when va.cluster_id = c.id then vb.cluster_id else va.cluster_id end)::int
        from duplicate_candidates d
        join videos va on va.id = d.video_a_id join videos vb on vb.id = d.video_b_id
        where d.status = 'possible' and va.cluster_id <> vb.cluster_id
          and (va.cluster_id = c.id or vb.cluster_id = c.id)) as "possibleDuplicates",
      (select array_agg(distinct v4.platform) from videos v4 where v4.cluster_id = c.id) as platforms,
      cl.labels, cl.safety_flags as "safetyFlags", cl.rationale as "aiSummary", cl.created_at as "classifiedAt",
      cf.error_kind as "classificationFailure", cf.attempted_at as "classificationFailedAt",
      ms.views, ms.likes, ms.comments, ms.shares, ms.captured_at as "metricsAt",
      (select count(*)::int from videos v2 where v2.cluster_id = c.id) as versions,
      coalesce(sg.sources, '[]'::jsonb) as sources,
      case s.state when 'scored' then 0 when 'provisional' then 1 when 'insufficient_evidence' then 2 else 3 end as "stateRank",
      coalesce(v.published_at, v.first_discovered_at) as "sortTime"
    from clusters c
    join lateral (
      select * from videos vv
      where vv.id = c.representative_video_id or vv.cluster_id = c.id
      order by (vv.id = c.representative_video_id) desc nulls last, vv.first_discovered_at, vv.id
      limit 1
    ) v on true
    left join creators cr on cr.id = v.creator_id
    left join lateral (
      select value, state, confidence, components, reason_codes, computed_at from scores
      where video_id = v.id and algorithm_version = ${scoreVersion}
      order by computed_at desc limit 1
    ) s on true
    left join lateral (
      select status, note, created_at from review_events
      where cluster_id = c.id order by created_at desc, id desc limit 1
    ) rv on true
    left join lateral (
      select status, created_at from rights where cluster_id = c.id order by created_at desc, id desc limit 1
    ) rt on true
    left join lateral (
      select max(merged_at) filter (where review_conflict) as review_at,
        max(merged_at) filter (where rights_conflict) as rights_at
      from cluster_merges where survivor_cluster_id = c.id
    ) mc on true
    left join lateral (
      select labels, safety_flags, rationale, created_at from classifications
      where cluster_id = c.id and taxonomy_version = ${TAXONOMY_VERSION} and prompt_version = ${PROMPT_VERSION}
      order by created_at desc limit 1
    ) cl on true
    left join lateral (
      select error_kind, attempted_at from classification_failures
      where cluster_id = c.id and taxonomy_version = ${TAXONOMY_VERSION} and prompt_version = ${PROMPT_VERSION}
      order by attempted_at desc limit 1
    ) cf on true
    left join lateral (
      select views, likes, comments, shares, captured_at from metric_snapshots
      where video_id = v.id order by captured_at desc limit 1
    ) ms on true
    left join lateral (
      select jsonb_agg(jsonb_build_object('source', x.name, 'adapterId', x.adapter_id, 'observations', x.n) order by x.name) as sources
      from (
        select so.name, so.adapter_id,
          count(distinct coalesce(nullif(g.observation_key, ''), g.id::text))::int as n
        from sightings g
        join sources so on so.id = g.source_id
        join videos v3 on v3.id = g.video_id
        where v3.cluster_id = c.id
        group by so.name, so.adapter_id
      ) x
    ) sg on true
    where c.merged_into_cluster_id is null`;
}

function filterSql(filters: FeedFilters, now: Date): SQL[] {
  const where: SQL[] = [];
  if (filters.review === 'unreviewed')
    where.push(sql`f."reviewStatus" is null and not f."reviewConflict"`);
  else if (filters.review === 'conflict')
    where.push(sql`(f."reviewConflict" or f."rightsConflict")`);
  else if (filters.review) where.push(sql`f."reviewStatus" = ${filters.review}`);
  if (filters.label)
    where.push(sql`f.labels @> ${JSON.stringify([{ label: filters.label }])}::jsonb`);
  if (filters.platform) where.push(sql`f.platform = ${filters.platform}`);
  if (filters.source)
    where.push(sql`f.sources @> ${JSON.stringify([{ source: filters.source }])}::jsonb`);
  if (filters.state === 'unscored') where.push(sql`f."scoreState" is null`);
  else if (filters.state) where.push(sql`f."scoreState" = ${filters.state}`);
  if (filters.minScore !== undefined) where.push(sql`f.score >= ${filters.minScore}`);
  if (filters.discoveredWithinHours !== undefined) {
    where.push(
      sql`f."firstDiscoveredAt" >= ${new Date(now.getTime() - filters.discoveredWithinHours * 3_600_000)}`,
    );
  }
  if (filters.rights) where.push(sql`f."rightsStatus" = ${filters.rights}`);
  if (filters.flagged)
    where.push(sql`jsonb_array_length(coalesce(f."safetyFlags", '[]'::jsonb)) > 0`);
  if (filters.possibleDuplicates) where.push(sql`f."possibleDuplicates" > 0`);
  return where;
}

export interface FeedPage {
  items: FeedRow[];
  nextCursor: string | null;
}

export async function getFeed(
  db: AnyDatabase,
  options: { filters?: FeedFilters; cursor?: string | null; pageSize?: number; now?: Date } = {},
): Promise<FeedPage> {
  const pageSize = Math.min(Math.max(options.pageSize ?? 25, 1), 100);
  const where = filterSql(options.filters ?? {}, options.now ?? new Date());
  const cursor = decodeCursor(options.cursor);
  if (cursor) {
    where.push(sql`(
      f."stateRank" > ${cursor.r}
      or (f."stateRank" = ${cursor.r} and (
        coalesce(f.score, -1) < ${cursor.s}
        or (coalesce(f.score, -1) = ${cursor.s} and (
          f."sortTime" < ${new Date(cursor.t)}
          or (f."sortTime" = ${new Date(cursor.t)} and f."clusterId" > ${cursor.id}::uuid)
        ))
      ))
    )`);
  }
  const whereSql = where.length ? sql`where ${sql.join(where, sql` and `)}` : sql``;
  const result = await rows<FeedRow>(
    db,
    sql`select * from (${baseQuery()}) f ${whereSql}
        order by f."stateRank" asc, coalesce(f.score, -1) desc, f."sortTime" desc, f."clusterId" asc
        limit ${pageSize + 1}`,
  );
  const items = result.slice(0, pageSize);
  const last = items[items.length - 1];
  return { items, nextCursor: result.length > pageSize && last ? encodeCursor(last) : null };
}

export interface FeedSummary {
  total: number;
  breakingOut: number;
  unreviewed: number;
  saved: number;
  approved: number;
  rejected: number;
  alreadyUsed: number;
  insufficientEvidence: number;
  flagged: number;
  unclassified: number;
  conflicts: number;
  possibleDuplicates: number;
}

/** "Breaking out" = scored with a latest virality score at or above this. */
export const BREAKING_OUT_SCORE = 70;

export async function getSummary(db: AnyDatabase): Promise<FeedSummary> {
  const [row] = await rows<FeedSummary>(
    db,
    sql`select
      count(*)::int as total,
      count(*) filter (where f."scoreState" = 'scored' and f.score >= ${BREAKING_OUT_SCORE})::int as "breakingOut",
      count(*) filter (where f."reviewStatus" is null and not f."reviewConflict")::int as unreviewed,
      count(*) filter (where f."reviewStatus" = 'saved')::int as saved,
      count(*) filter (where f."reviewStatus" = 'approved')::int as approved,
      count(*) filter (where f."reviewStatus" = 'rejected')::int as rejected,
      count(*) filter (where f."reviewStatus" = 'already_used')::int as "alreadyUsed",
      count(*) filter (where f."scoreState" = 'insufficient_evidence')::int as "insufficientEvidence",
      count(*) filter (where jsonb_array_length(coalesce(f."safetyFlags", '[]'::jsonb)) > 0)::int as flagged,
      count(*) filter (where f.labels is null)::int as unclassified,
      count(*) filter (where f."reviewConflict" or f."rightsConflict")::int as conflicts,
      count(*) filter (where f."possibleDuplicates" > 0)::int as "possibleDuplicates"
    from (${baseQuery()}) f`,
  );
  return (
    row ?? {
      total: 0,
      breakingOut: 0,
      unreviewed: 0,
      saved: 0,
      approved: 0,
      rejected: 0,
      alreadyUsed: 0,
      insufficientEvidence: 0,
      flagged: 0,
      unclassified: 0,
      conflicts: 0,
      possibleDuplicates: 0,
    }
  );
}

/** Values for filter dropdowns, from what actually exists in the data. */
export async function getFilterOptions(
  db: AnyDatabase,
): Promise<{ platforms: string[]; sources: string[] }> {
  const platforms = await rows<{ platform: string }>(
    db,
    sql`select distinct platform from videos order by platform`,
  );
  const sources = await rows<{ name: string }>(db, sql`select name from sources order by name`);
  return { platforms: platforms.map((p) => p.platform), sources: sources.map((s) => s.name) };
}
