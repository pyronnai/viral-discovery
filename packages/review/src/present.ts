/**
 * Pure view models for the dashboard. The UI renders these; it never re-derives
 * meaning (e.g. whether a source is public propagation) on its own.
 */
import { SIGNIFICANT_FLAGS, type SafetyFlag } from '@vd/classification';
import { summarizeEvidence, type DuplicateEvidence } from '@vd/dedupe';
import type { CandidateDetail, DetailDuplicate, DetailMerge } from './detail.ts';
import type { FeedRow, SourceCount } from './feed.ts';

export type SightingRoles = Record<string, 'propagation' | 'provenance'>;

const PLATFORM_NAMES: Record<string, string> = {
  youtube: 'YouTube',
  twitch: 'Twitch',
  bluesky: 'Bluesky',
  tiktok: 'TikTok',
};
export function platformName(platform: string): string {
  return PLATFORM_NAMES[platform] ?? platform.charAt(0).toUpperCase() + platform.slice(1);
}

export const STATE_LABELS = {
  scored: 'SCORED',
  provisional: 'PROVISIONAL',
  insufficient_evidence: 'INSUFFICIENT EVIDENCE',
  unscored: 'NOT SCORED YET',
} as const;

export const REVIEW_LABELS: Record<string, string> = {
  approved: 'Approved',
  rejected: 'Rejected',
  saved: 'Saved',
  already_used: 'Already used',
};

export const RIGHTS_LABELS: Record<string, string> = {
  unknown: 'Unknown',
  requested: 'Requested',
  granted: 'Granted',
  denied: 'Denied',
  own_content: 'Own content',
  conflict: 'Needs review (merge conflict)',
};

export const COMPONENT_LABELS: Record<string, string> = {
  velocity: 'Velocity',
  acceleration: 'Acceleration',
  engagement: 'Engagement',
  freshness: 'Freshness',
  crossSource: 'Cross-source',
  sourcePropagation: 'Source propagation',
  creatorOutlier: 'Creator outlier',
};

export function confidenceLabel(confidence: number | null): string {
  if (confidence === null) return '—';
  if (confidence >= 0.75) return 'High';
  if (confidence >= 0.5) return 'Medium';
  return 'Low';
}

export function formatCount(n: number | null): string {
  if (n === null) return '—';
  const short = (value: number, digits: number) => value.toFixed(digits).replace(/\.0$/, '');
  if (n >= 1_000_000) return `${short(n / 1_000_000, n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${short(n / 1_000, n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function formatAge(from: Date | null, now: Date): string {
  if (!from) return '—';
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(from).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Splits sightings into public propagation vs provenance using adapter-declared roles. */
export function splitSources(sources: SourceCount[], roles: SightingRoles) {
  const publicPropagation: SourceCount[] = [];
  const provenance: SourceCount[] = [];
  for (const s of sources) {
    // Unknown adapters are provenance: they must never look like spread.
    (roles[s.adapterId] === 'propagation' ? publicPropagation : provenance).push(s);
  }
  return { publicPropagation, provenance };
}

export interface ComponentView {
  key: string;
  label: string;
  available: boolean;
  /** e.g. "very strong", or "unavailable". */
  strength: string;
  value: number | null;
  reason: string | null;
  basis: string;
}

export function componentViews(components: Record<string, unknown> | null): ComponentView[] {
  if (!components) return [];
  return Object.keys(COMPONENT_LABELS).flatMap((key) => {
    const c = components[key] as
      | { available?: boolean; strength?: string; value?: number; reason?: string; basis?: string }
      | undefined;
    if (!c) return [];
    return [
      {
        key,
        label: COMPONENT_LABELS[key] ?? key,
        available: c.available === true,
        strength: c.available ? (c.strength ?? '—') : 'unavailable',
        value: c.available && typeof c.value === 'number' ? c.value : null,
        reason: c.available ? null : (c.reason ?? null),
        basis: c.basis ?? 'canonical',
      },
    ];
  });
}

export type ClassificationState =
  | { kind: 'classified'; labels: { label: string; confidence: number }[] }
  | { kind: 'failed'; error: string }
  | { kind: 'unclassified' };

export interface CardView {
  clusterId: string;
  href: string;
  canonicalUrl: string;
  platform: string;
  title: string;
  creator: string | null;
  creatorHandle: string | null;
  thumbnailUrl: string | null;
  age: string;
  ageBasis: 'published' | 'discovered';
  duration: string;
  score: {
    text: string;
    value: number | null;
    state: keyof typeof STATE_LABELS;
    stateLabel: string;
    confidence: string;
  };
  components: ComponentView[];
  reasonCodes: string[];
  classification: ClassificationState;
  aiSummary: string | null;
  flags: { flag: string; significant: boolean; note: string }[];
  publicPropagation: SourceCount[];
  provenance: SourceCount[];
  versions: number;
  /** Platform names of the confirmed versions (representations) in this cluster. */
  versionPlatforms: string[];
  /** e.g. "2 possible duplicates"; null when there are none. */
  duplicatesLabel: string | null;
  possibleDuplicates: number;
  conflicts: { review: boolean; rights: boolean };
  metrics: {
    views: string;
    likes: string;
    comments: string;
    shares: string;
    at: Date | null;
  } | null;
  review: { status: string | null; label: string; note: string | null };
  rights: { status: string; label: string };
  availabilityNote: string | null;
}

export function toCardView(row: FeedRow, roles: SightingRoles, now: Date): CardView {
  const state = row.scoreState ?? 'unscored';
  const { publicPropagation, provenance } = splitSources(row.sources, roles);
  const classifiedAt = row.classifiedAt ? new Date(row.classifiedAt).getTime() : 0;
  const failedAt = row.classificationFailedAt ? new Date(row.classificationFailedAt).getTime() : 0;
  const classification: ClassificationState =
    row.labels && classifiedAt >= failedAt
      ? { kind: 'classified', labels: row.labels }
      : row.classificationFailure
        ? { kind: 'failed', error: row.classificationFailure }
        : { kind: 'unclassified' };
  const hasMetrics = [row.views, row.likes, row.comments, row.shares].some((v) => v !== null);
  return {
    clusterId: row.clusterId,
    href: `/candidates/${row.clusterId}`,
    canonicalUrl: row.canonicalUrl,
    platform: platformName(row.platform),
    title: row.title ?? row.caption?.slice(0, 140) ?? '(untitled)',
    creator: row.creatorName,
    creatorHandle: row.creatorHandle,
    thumbnailUrl:
      row.thumbnailUrl && /^https:\/\//.test(row.thumbnailUrl) ? row.thumbnailUrl : null,
    age: formatAge(row.publishedAt ?? row.firstDiscoveredAt, now),
    ageBasis: row.publishedAt ? 'published' : 'discovered',
    duration: formatDuration(row.durationMs),
    score: {
      // A missing score is shown as a dash, never as zero.
      text: row.score === null ? '—' : String(Math.round(row.score)),
      value: row.score,
      state,
      stateLabel: STATE_LABELS[state],
      confidence: confidenceLabel(row.confidence),
    },
    components: componentViews(row.scoreComponents),
    reasonCodes: row.reasonCodes ?? [],
    classification,
    aiSummary: classification.kind === 'classified' ? row.aiSummary : null,
    flags: (classification.kind === 'classified' ? (row.safetyFlags ?? []) : []).map((f) => ({
      flag: f.flag,
      note: f.note,
      significant: (SIGNIFICANT_FLAGS as readonly string[]).includes(f.flag as SafetyFlag),
    })),
    publicPropagation,
    provenance,
    versions: row.versions,
    versionPlatforms: [...row.platforms].sort().map(platformName),
    possibleDuplicates: row.possibleDuplicates,
    duplicatesLabel: row.possibleDuplicates
      ? `${row.possibleDuplicates} possible duplicate${row.possibleDuplicates === 1 ? '' : 's'}`
      : null,
    conflicts: { review: row.reviewConflict, rights: row.rightsConflict },
    metrics: hasMetrics
      ? {
          views: formatCount(row.views),
          likes: formatCount(row.likes),
          comments: formatCount(row.comments),
          shares: formatCount(row.shares),
          at: row.metricsAt,
        }
      : null,
    review: {
      status: row.reviewStatus,
      label: row.reviewConflict
        ? 'Review conflict'
        : row.reviewStatus
          ? (REVIEW_LABELS[row.reviewStatus] ?? row.reviewStatus)
          : 'Unreviewed',
      note: row.reviewNote,
    },
    rights: {
      status: row.rightsStatus,
      label: RIGHTS_LABELS[row.rightsStatus] ?? row.rightsStatus,
    },
    availabilityNote:
      row.availability === 'removed'
        ? 'Source reports this video was removed'
        : row.availability === 'private'
          ? 'Source reports this video is private'
          : null,
  };
}

/** Points for a small growth chart: the first metric with values across snapshots. */
export function growthSeries(
  snapshots: { capturedAt: Date; views: number | null; likes: number | null }[],
): { metric: 'views' | 'likes'; points: { at: Date; value: number }[] } | null {
  for (const metric of ['views', 'likes'] as const) {
    const points = snapshots.flatMap((s) =>
      s[metric] === null ? [] : [{ at: new Date(s.capturedAt), value: s[metric] }],
    );
    if (points.length >= 2) return { metric, points };
  }
  return null;
}

// ── near-duplicates ────────────────────────────────────────────────────────
const BLOCKER_TEXT: Record<string, string> = {
  NO_DURATION: 'duration unknown on one side',
  NO_THUMBNAIL_HASH: 'thumbnails could not be compared',
  THUMBNAIL_NOT_CLOSE_ENOUGH: 'thumbnails only similar',
  DURATION_NOT_EXACT: 'durations differ slightly',
  NO_SUPPORTING_METADATA: 'no supporting title or creator match',
  TITLE_NUMBERS_CONFLICT: 'titles contain different numbers',
  SAME_PLATFORM: 'same platform (could be a re-upload or a series)',
  SCORE_BELOW_AUTO_THRESHOLD: 'evidence below the auto-confirm level',
  BOTH_SIDES_REVIEWED: 'both already have review/rights history',
};

export interface DuplicateView {
  candidateId: string;
  otherClusterId: string;
  href: string;
  platform: string;
  title: string;
  creator: string | null;
  thumbnailUrl: string | null;
  duration: string;
  canonicalUrl: string;
  confidence: number;
  confidenceText: string;
  strength: string;
  evidence: string[];
  /** Why this was not merged automatically. */
  needsHumanBecause: string[];
  note: string | null;
  decidedAt: Date | null;
}

function evidenceLines(evidence: Record<string, unknown>): string[] {
  try {
    return summarizeEvidence(evidence as unknown as DuplicateEvidence);
  } catch {
    return ['Evidence unavailable'];
  }
}

export function toDuplicateView(d: DetailDuplicate): DuplicateView {
  return {
    candidateId: d.candidateId,
    otherClusterId: d.otherClusterId,
    href: `/candidates/${d.otherClusterId}`,
    platform: platformName(d.platform),
    title: d.title ?? d.caption?.slice(0, 140) ?? '(untitled)',
    creator: d.creator,
    thumbnailUrl: d.thumbnailUrl && /^https:\/\//.test(d.thumbnailUrl) ? d.thumbnailUrl : null,
    duration: formatDuration(d.durationMs),
    canonicalUrl: d.canonicalUrl,
    confidence: d.confidence,
    confidenceText: `${Math.round(d.confidence * 100)}%`,
    strength: confidenceLabel(d.confidence),
    evidence: evidenceLines(d.evidence),
    needsHumanBecause: d.reasons
      .filter((r) => r.startsWith('AUTO_BLOCKED_'))
      .map((r) => BLOCKER_TEXT[r.slice('AUTO_BLOCKED_'.length)] ?? r),
    note: d.note,
    decidedAt: d.decidedAt,
  };
}

export interface VersionView {
  videoId: string;
  platform: string;
  title: string;
  creator: string | null;
  duration: string;
  canonicalUrl: string;
  thumbnailUrl: string | null;
  isRepresentative: boolean;
  /** How this representation joined the cluster. */
  joined: string;
}

export function versionViews(
  detail: Pick<CandidateDetail, 'versions' | 'confirmations'>,
): VersionView[] {
  return detail.versions.map((v) => {
    // Each confirmation links two versions; describe it from this version's side.
    const partnerName = (id: string) => {
      const partner = detail.versions.find((x) => x.videoId === id);
      return partner ? platformName(partner.platform) : 'another version';
    };
    const links = detail.confirmations.flatMap((c) => {
      const other =
        c.videoAId === v.videoId ? c.videoBId : c.videoBId === v.videoId ? c.videoAId : null;
      if (!other) return [];
      return [
        c.status === 'auto_confirmed'
          ? `auto-confirmed same as ${partnerName(other)} (confidence ${c.confidence.toFixed(2)})`
          : `confirmed same as ${partnerName(other)} by ${c.decidedBy ?? 'owner'}`,
      ];
    });
    const joined = links.length ? links.join('; ') : 'exact identity';
    return {
      videoId: v.videoId,
      platform: platformName(v.platform),
      title: v.title ?? '(untitled)',
      creator: v.creator,
      duration: formatDuration(v.durationMs),
      canonicalUrl: v.canonicalUrl,
      thumbnailUrl: v.thumbnailUrl && /^https:\/\//.test(v.thumbnailUrl) ? v.thumbnailUrl : null,
      isRepresentative: v.isRepresentative,
      joined,
    };
  });
}

export interface ConflictView {
  kind: 'review' | 'rights';
  title: string;
  reason: string | null;
  sides: { versions: string; value: string }[];
}

interface MergeSide {
  platforms?: string[];
  review?: string | null;
  reviewConflict?: boolean;
  rights?: string | null;
  rightsHolder?: string | null;
  rightsConflict?: boolean;
}

/** Open merge conflicts, with what each merged side had decided. */
export function conflictViews(
  summary: Pick<FeedRow, 'reviewConflict' | 'rightsConflict'>,
  merges: DetailMerge[],
): ConflictView[] {
  const out: ConflictView[] = [];
  const describe = (m: DetailMerge, kind: 'review' | 'rights') => {
    const sides = (m.details['sides'] as MergeSide[] | undefined) ?? [];
    return sides.map((side) => ({
      versions: (side.platforms ?? []).map(platformName).join(', ') || 'unknown',
      value:
        kind === 'review'
          ? side.reviewConflict
            ? 'already in conflict'
            : side.review
              ? (REVIEW_LABELS[side.review] ?? side.review)
              : 'no decision'
          : side.rightsConflict
            ? 'already in conflict'
            : side.rights
              ? `${RIGHTS_LABELS[side.rights] ?? side.rights}${side.rightsHolder ? ` (holder: ${side.rightsHolder})` : ''}`
              : 'no record',
    }));
  };
  const latest = (flag: 'reviewConflict' | 'rightsConflict') =>
    [...merges]
      .sort((a, b) => new Date(b.mergedAt).getTime() - new Date(a.mergedAt).getTime())
      .find((m) => m[flag]);
  const review = summary.reviewConflict ? latest('reviewConflict') : undefined;
  if (review) {
    out.push({
      kind: 'review',
      title:
        'Review conflict — merged versions had different decisions. Choose a decision to resolve it.',
      reason: (review.details['reviewReason'] as string | null | undefined) ?? null,
      sides: describe(review, 'review'),
    });
  }
  const rights = summary.rightsConflict ? latest('rightsConflict') : undefined;
  if (rights) {
    out.push({
      kind: 'rights',
      title:
        'Rights need review — records from merged versions cannot be combined automatically. Record the rights that apply to this content.',
      reason: (rights.details['rightsReason'] as string | null | undefined) ?? null,
      sides: describe(rights, 'rights'),
    });
  }
  return out;
}
