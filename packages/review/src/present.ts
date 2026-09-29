/**
 * Pure view models for the dashboard. The UI renders these; it never re-derives
 * meaning (e.g. whether a source is public propagation) on its own.
 */
import { SIGNIFICANT_FLAGS, type SafetyFlag } from '@vd/classification';
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
      label: row.reviewStatus
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
