/**
 * Everything the candidate detail page shows. Loaded for ONE cluster at a time,
 * so it may fetch full histories that the feed deliberately skips.
 */
import { sql } from 'drizzle-orm';
import { PROMPT_VERSION, TAXONOMY_VERSION } from '@vd/classification';
import type { AnyDatabase } from '@vd/db';
import { baseQuery, rows, type FeedRow } from './feed.ts';

export interface DetailVersion {
  videoId: string;
  platform: string;
  platformVideoId: string;
  canonicalUrl: string;
  title: string | null;
  availability: string;
  isRepresentative: boolean;
  thumbnailUrl: string | null;
  durationMs: number | null;
  creator: string | null;
  publishedAt: Date | null;
  firstDiscoveredAt: Date;
}

/** A confirmed near-duplicate link inside this cluster (how versions were joined). */
export interface DetailConfirmation {
  candidateId: string;
  videoAId: string;
  videoBId: string;
  status: 'confirmed' | 'auto_confirmed';
  confidence: number;
  decidedAt: Date | null;
  decidedBy: string | null;
}

/** A possible (or rejected) duplicate: another cluster's video paired with one of ours. */
export interface DetailDuplicate {
  candidateId: string;
  status: string;
  confidence: number;
  evidence: Record<string, unknown>;
  reasons: string[];
  firstDetectedAt: Date;
  decidedAt: Date | null;
  note: string | null;
  thisVideoId: string;
  otherVideoId: string;
  otherClusterId: string;
  platform: string;
  title: string | null;
  caption: string | null;
  thumbnailUrl: string | null;
  durationMs: number | null;
  canonicalUrl: string;
  creator: string | null;
}

export interface DetailMerge {
  id: string;
  trigger: string;
  absorbedClusterId: string;
  reviewConflict: boolean;
  rightsConflict: boolean;
  details: Record<string, unknown>;
  mergedAt: Date;
}

export interface DetailSighting {
  source: string;
  adapterId: string;
  observationKey: string;
  seenAt: Date;
  videoId: string;
  context: Record<string, unknown>;
}

export interface DetailSnapshot {
  capturedAt: Date;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  unavailable: Record<string, string>;
  source: string | null;
}

export interface DetailScore {
  algorithmVersion: string;
  value: number | null;
  state: string;
  confidence: number;
  components: Record<string, unknown>;
  reasonCodes: string[];
  computedAt: Date;
  nextRescoreAt: Date | null;
}

export interface DetailClassification {
  id: string;
  provider: string;
  model: string;
  taxonomyVersion: string;
  promptVersion: string;
  labels: { label: string; confidence: number }[];
  safetyFlags: { flag: string; confidence: number; note: string }[];
  summary: string | null;
  analysis: Record<string, string | null>;
  inputsUsed: Record<string, unknown>;
  classifiedAt: Date;
  current: boolean;
}

export interface DetailFailure {
  errorKind: string;
  error: string;
  provider: string;
  model: string;
  attemptedAt: Date;
}

export interface DetailReview {
  status: string;
  note: string | null;
  reviewer: string;
  /** Set when a merge carried this event over from another cluster. */
  originClusterId: string | null;
  createdAt: Date;
}

export interface DetailRights {
  status: string;
  rightsHolder: string | null;
  contact: string | null;
  licenseTerms: string | null;
  evidenceUrl: string | null;
  notes: string | null;
  originClusterId: string | null;
  createdAt: Date;
}

export interface CandidateDetail {
  summary: FeedRow;
  versions: DetailVersion[];
  sightings: DetailSighting[];
  snapshots: DetailSnapshot[];
  scores: DetailScore[];
  classifications: DetailClassification[];
  failures: DetailFailure[];
  reviews: DetailReview[];
  rights: DetailRights[];
  confirmations: DetailConfirmation[];
  possibleDuplicates: DetailDuplicate[];
  rejectedDuplicates: DetailDuplicate[];
  merges: DetailMerge[];
}

/** For a merged-away cluster id: the cluster that now holds its videos (old links redirect). */
export async function mergedInto(db: AnyDatabase, clusterId: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(clusterId)) return null;
  const [row] = await rows<{ into: string | null }>(
    db,
    sql`select merged_into_cluster_id as into from clusters where id = ${clusterId}::uuid`,
  );
  return row?.into ?? null;
}

function duplicatesQuery(clusterId: string, status: 'possible' | 'rejected') {
  return sql`select d.id as "candidateId", d.status::text as status, d.confidence, d.evidence, d.reasons,
      d.first_detected_at as "firstDetectedAt", d.decided_at as "decidedAt", d.note,
      mine.id as "thisVideoId", other.id as "otherVideoId", other.cluster_id as "otherClusterId",
      other.platform, other.title, other.caption, other.thumbnail_url as "thumbnailUrl",
      other.duration_ms as "durationMs", other.canonical_url as "canonicalUrl",
      coalesce(cr.display_name, other.creator_display_name) as creator
    from duplicate_candidates d
    join videos mine on (mine.id = d.video_a_id or mine.id = d.video_b_id) and mine.cluster_id = ${clusterId}::uuid
    join videos other on (other.id = d.video_a_id or other.id = d.video_b_id) and other.id <> mine.id
      and other.cluster_id <> ${clusterId}::uuid
    left join creators cr on cr.id = other.creator_id
    where d.status = ${status}
    order by d.confidence desc, d.id
    limit 50`;
}

export async function getCandidate(
  db: AnyDatabase,
  clusterId: string,
): Promise<CandidateDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(clusterId)) return null;
  const [summary] = await rows<FeedRow>(
    db,
    sql`select * from (${baseQuery()}) f where f."clusterId" = ${clusterId}::uuid`,
  );
  if (!summary) return null;

  const [
    versions,
    sightings,
    snapshots,
    scores,
    classifications,
    failures,
    reviews,
    rights,
    confirmations,
    possible,
    rejected,
    merges,
  ] = await Promise.all([
    rows<DetailVersion>(
      db,
      sql`select v.id as "videoId", v.platform, v.platform_video_id as "platformVideoId",
            v.canonical_url as "canonicalUrl", v.title, v.availability::text as availability,
            (v.id = ${summary.videoId}::uuid) as "isRepresentative",
            v.thumbnail_url as "thumbnailUrl", v.duration_ms as "durationMs",
            coalesce(cr.display_name, v.creator_display_name) as creator,
            v.published_at as "publishedAt", v.first_discovered_at as "firstDiscoveredAt"
          from videos v left join creators cr on cr.id = v.creator_id
          where v.cluster_id = ${clusterId}::uuid
          order by (v.id = ${summary.videoId}::uuid) desc, v.first_discovered_at, v.id`,
    ),
    rows<DetailSighting>(
      db,
      sql`select so.name as source, so.adapter_id as "adapterId",
            coalesce(nullif(g.observation_key, ''), g.id::text) as "observationKey",
            g.seen_at as "seenAt", g.video_id as "videoId", g.context
          from sightings g join sources so on so.id = g.source_id join videos v on v.id = g.video_id
          where v.cluster_id = ${clusterId}::uuid order by g.seen_at desc limit 200`,
    ),
    rows<DetailSnapshot>(
      db,
      sql`select m.captured_at as "capturedAt", m.views, m.likes, m.comments, m.shares, m.unavailable,
            so.name as source
          from metric_snapshots m left join sources so on so.id = m.source_id
          where m.video_id = ${summary.videoId}::uuid order by m.captured_at asc limit 500`,
    ),
    rows<DetailScore>(
      db,
      sql`select algorithm_version as "algorithmVersion", value, state::text as state, confidence, components,
            reason_codes as "reasonCodes", computed_at as "computedAt", next_rescore_at as "nextRescoreAt"
          from scores where video_id = ${summary.videoId}::uuid order by computed_at desc limit 100`,
    ),
    rows<DetailClassification>(
      db,
      sql`select id, provider, model, taxonomy_version as "taxonomyVersion", prompt_version as "promptVersion",
            labels, safety_flags as "safetyFlags", rationale as summary, analysis, inputs_used as "inputsUsed",
            created_at as "classifiedAt",
            (taxonomy_version = ${TAXONOMY_VERSION} and prompt_version = ${PROMPT_VERSION}) as current
          from classifications where cluster_id = ${clusterId}::uuid order by created_at desc limit 20`,
    ),
    rows<DetailFailure>(
      db,
      sql`select error_kind as "errorKind", error, provider, model, attempted_at as "attemptedAt"
          from classification_failures where cluster_id = ${clusterId}::uuid order by attempted_at desc limit 5`,
    ),
    rows<DetailReview>(
      db,
      sql`select status::text as status, note, reviewer, origin_cluster_id as "originClusterId",
            created_at as "createdAt"
          from review_events where cluster_id = ${clusterId}::uuid order by created_at desc, id desc`,
    ),
    rows<DetailRights>(
      db,
      sql`select status::text as status, rights_holder as "rightsHolder", contact, license_terms as "licenseTerms",
            evidence_url as "evidenceUrl", notes, origin_cluster_id as "originClusterId",
            created_at as "createdAt"
          from rights where cluster_id = ${clusterId}::uuid order by created_at desc, id desc`,
    ),
    rows<DetailConfirmation>(
      db,
      sql`select d.id as "candidateId", d.video_a_id as "videoAId", d.video_b_id as "videoBId",
            d.status::text as status, d.confidence, d.decided_at as "decidedAt", d.decided_by as "decidedBy"
          from duplicate_candidates d
          join videos va on va.id = d.video_a_id join videos vb on vb.id = d.video_b_id
          where d.status in ('confirmed', 'auto_confirmed')
            and va.cluster_id = ${clusterId}::uuid and vb.cluster_id = ${clusterId}::uuid
          order by d.decided_at, d.id`,
    ),
    rows<DetailDuplicate>(db, duplicatesQuery(clusterId, 'possible')),
    rows<DetailDuplicate>(db, duplicatesQuery(clusterId, 'rejected')),
    rows<DetailMerge>(
      db,
      sql`select id, trigger, absorbed_cluster_id as "absorbedClusterId", review_conflict as "reviewConflict",
            rights_conflict as "rightsConflict", details, merged_at as "mergedAt"
          from cluster_merges
          where survivor_cluster_id = ${clusterId}::uuid
            or survivor_cluster_id in (select id from clusters where merged_into_cluster_id = ${clusterId}::uuid)
          order by merged_at desc, id`,
    ),
  ]);
  // One suggestion per other cluster (its strongest pair).
  const possibleDuplicates = possible.filter(
    (d, i) => possible.findIndex((x) => x.otherClusterId === d.otherClusterId) === i,
  );
  return {
    summary,
    versions,
    sightings,
    snapshots,
    scores,
    classifications,
    failures,
    reviews,
    rights,
    confirmations,
    possibleDuplicates,
    rejectedDuplicates: rejected.slice(0, 10),
    merges,
  };
}

/**
 * Other candidates from the same creator (same creator record, or the same
 * platform + handle/display name), newest first. Bounded: this is a quick
 * "is this account worth watching?" glance, not creator analytics.
 */
export async function getCreatorHistory(
  db: AnyDatabase,
  clusterId: string,
  limit = 6,
): Promise<FeedRow[]> {
  if (!/^[0-9a-f-]{36}$/i.test(clusterId)) return [];
  return rows<FeedRow>(
    db,
    sql`with mine as (
        select creator_id, platform, lower(coalesce(creator_handle, '')) as handle,
          lower(coalesce(creator_display_name, '')) as name
        from videos where cluster_id = ${clusterId}::uuid
      ), related as (
        select distinct v.cluster_id from videos v join mine m on
          (m.creator_id is not null and v.creator_id = m.creator_id)
          or (v.platform = m.platform and m.handle <> '' and lower(v.creator_handle) = m.handle)
          or (v.platform = m.platform and m.name <> '' and lower(v.creator_display_name) = m.name)
        where v.cluster_id <> ${clusterId}::uuid
      )
      select * from (${baseQuery()}) f
      where f."clusterId" in (select cluster_id from related)
      order by f."sortTime" desc, f."clusterId"
      limit ${Math.min(Math.max(limit, 1), 20)}`,
  );
}
