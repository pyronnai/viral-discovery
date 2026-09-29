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
  createdAt: Date;
}

export interface DetailRights {
  status: string;
  rightsHolder: string | null;
  contact: string | null;
  licenseTerms: string | null;
  evidenceUrl: string | null;
  notes: string | null;
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

  const [versions, sightings, snapshots, scores, classifications, failures, reviews, rights] =
    await Promise.all([
      rows<DetailVersion>(
        db,
        sql`select v.id as "videoId", v.platform, v.platform_video_id as "platformVideoId",
            v.canonical_url as "canonicalUrl", v.title, v.availability::text as availability,
            (v.id = ${summary.videoId}::uuid) as "isRepresentative"
          from videos v where v.cluster_id = ${clusterId}::uuid order by v.first_discovered_at, v.id`,
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
        sql`select status::text as status, note, reviewer, created_at as "createdAt"
          from review_events where cluster_id = ${clusterId}::uuid order by created_at desc, id desc`,
      ),
      rows<DetailRights>(
        db,
        sql`select status::text as status, rights_holder as "rightsHolder", contact, license_terms as "licenseTerms",
            evidence_url as "evidenceUrl", notes, created_at as "createdAt"
          from rights where cluster_id = ${clusterId}::uuid order by created_at desc, id desc`,
      ),
    ]);
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
  };
}
