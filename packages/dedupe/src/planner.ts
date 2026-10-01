/**
 * Duplicate-aware candidate filtering for FUTURE consumers (e.g. a compilation
 * planner). Given content that is already selected, return candidates that are
 * not the same underlying clip:
 *  - confirmed duplicates share a cluster, so a candidate cluster that is (or was
 *    merged into) a selected cluster is excluded;
 *  - an open "possible" duplicate of selected content at or above
 *    `minPossibleConfidence` is excluded too (the conservative choice for
 *    selection: a missed merge must not produce the same clip twice);
 *  - human-rejected pairs never exclude anything.
 */
import { sql } from 'drizzle-orm';
import { rows, type Executor } from './state.ts';

export interface DuplicateExclusion {
  clusterId: string;
  reason: 'selected' | 'confirmed_duplicate' | 'possible_duplicate';
  /** The selected cluster it duplicates. */
  ofClusterId: string;
  confidence: number | null;
}

export interface ExclusionQuery {
  selectedClusterIds?: string[];
  selectedVideoIds?: string[];
  /** Clusters to filter; defaults to every active cluster. */
  candidateClusterIds?: string[];
  /** Default 0.6. */
  minPossibleConfidence?: number;
}

export const DEFAULT_MIN_POSSIBLE_CONFIDENCE = 0.6;

const uuids = (ids: readonly string[]) =>
  sql`ARRAY[${sql.join(
    ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id)).map((id) => sql`${id}`),
    sql`, `,
  )}]::text[]::uuid[]`;

/** id → active (surviving) cluster id, following merge pointers. */
async function resolveMany(db: Executor, ids: readonly string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!ids.length) return map;
  const found = await rows<{ id: string; active: string }>(
    db,
    sql`select c.id, coalesce(c2.merged_into_cluster_id, c.merged_into_cluster_id, c.id) as active
      from clusters c left join clusters c2 on c2.id = c.merged_into_cluster_id
      where c.id = any(${uuids(ids)})`,
  );
  for (const f of found) map.set(f.id, f.active);
  return map;
}

export async function excludeDuplicatesOfSelected(
  db: Executor,
  query: ExclusionQuery,
): Promise<{ kept: string[]; excluded: DuplicateExclusion[] }> {
  const minConfidence = query.minPossibleConfidence ?? DEFAULT_MIN_POSSIBLE_CONFIDENCE;
  const selectedFromVideos = query.selectedVideoIds?.length
    ? (
        await rows<{ clusterId: string }>(
          db,
          sql`select distinct cluster_id as "clusterId" from videos
            where id = any(${uuids(query.selectedVideoIds)}) and cluster_id is not null`,
        )
      ).map((r) => r.clusterId)
    : [];
  const selectedRaw = [...(query.selectedClusterIds ?? []), ...selectedFromVideos];
  const selectedMap = await resolveMany(db, selectedRaw);
  const selected = new Set(selectedMap.values());

  const candidatesRaw =
    query.candidateClusterIds ??
    (
      await rows<{ id: string }>(
        db,
        sql`select id from clusters where merged_into_cluster_id is null order by created_at, id`,
      )
    ).map((r) => r.id);
  const candidateMap = await resolveMany(db, candidatesRaw);

  // Open possible-duplicate links between any candidate and any selected cluster.
  const links = new Map<string, { of: string; confidence: number }>();
  if (selected.size) {
    const found = await rows<{ clusterId: string; ofClusterId: string; confidence: number }>(
      db,
      sql`select case when va.cluster_id = any(${uuids([...selected])}) then vb.cluster_id else va.cluster_id end as "clusterId",
          case when va.cluster_id = any(${uuids([...selected])}) then va.cluster_id else vb.cluster_id end as "ofClusterId",
          d.confidence
        from duplicate_candidates d
        join videos va on va.id = d.video_a_id join videos vb on vb.id = d.video_b_id
        where d.status = 'possible' and d.confidence >= ${minConfidence}
          and va.cluster_id <> vb.cluster_id
          and (va.cluster_id = any(${uuids([...selected])}) or vb.cluster_id = any(${uuids([...selected])}))`,
    );
    for (const f of found) {
      const prev = links.get(f.clusterId);
      if (!prev || f.confidence > prev.confidence)
        links.set(f.clusterId, { of: f.ofClusterId, confidence: f.confidence });
    }
  }

  const kept: string[] = [];
  const excluded: DuplicateExclusion[] = [];
  const seen = new Set<string>();
  for (const raw of candidatesRaw) {
    const active = candidateMap.get(raw);
    if (!active || seen.has(active)) continue;
    seen.add(active);
    if (selected.has(active)) {
      excluded.push({
        clusterId: active,
        reason:
          raw !== active || !selectedRaw.includes(active) ? 'confirmed_duplicate' : 'selected',
        ofClusterId: active,
        confidence: null,
      });
      continue;
    }
    const link = links.get(active);
    if (link) {
      excluded.push({
        clusterId: active,
        reason: 'possible_duplicate',
        ofClusterId: link.of,
        confidence: link.confidence,
      });
      continue;
    }
    kept.push(active);
  }
  return { kept, excluded };
}
