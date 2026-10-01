/**
 * Explainable, deterministic near-duplicate assessment of two videos with
 * DIFFERENT exact identities. No model is involved.
 *
 * Each signal is measured, graded, and turned into points; the evidence (raw
 * measurement + grade + points) is stored so every decision can be explained.
 * Popularity (views, scores) and content category are deliberately NOT inputs:
 * two different videos can be equally viral or equally "funny animals".
 *
 * False merges are worse than missed merges, so:
 *  - no single signal can produce a match (≥ 2 independent positive signals);
 *  - a clear duration mismatch vetoes a match outright;
 *  - auto-confirmation needs a very close thumbnail AND matching duration AND
 *    supporting metadata (title or creator), across platforms, with no
 *    conflicting numbers in the titles. Everything else waits for a human.
 */
import { hammingDistance, isHash } from './phash.ts';
import { compareTokens, normalizeText, type TextTokens } from './tokens.ts';

export const DETECTOR_VERSION = 'near-dup-v1';

export const THRESHOLDS = {
  /** Hamming distance between 64-bit pHashes (random pairs average ~32). */
  thumbnail: { identical: 3, veryClose: 7, similar: 14, different: 22 },
  /** A difference passes a grade if it is within EITHER the absolute or the relative bound. */
  duration: {
    match: { ms: 1_000, ratio: 0.03 },
    close: { ms: 3_000, ratio: 0.1 },
    different: { ms: 5_000, ratio: 0.25 },
  },
  title: { strongJaccard: 0.6, moderateJaccard: 0.35, containment: 0.8, containmentMin: 3 },
  publication: { closeHours: 72, nearHours: 24 * 30 },
  possibleMinScore: 40,
  autoMinScore: 75,
} as const;

export const POINTS = {
  thumbnail: { identical: 45, very_close: 35, similar: 15, inconclusive: 0, different: -30 },
  duration: { match: 25, close: 12, inconclusive: 0, different: -50 },
  title: { strong: 20, moderate: 10, weak: 4, none: 0 },
  numbersConflict: -20,
  creatorSame: 10,
  publication: { close: 5, near: 2, far: 0 },
  sharedReference: 5,
} as const;

export interface MatchProfile {
  videoId: string;
  platform: string;
  durationMs: number | null;
  publishedAt: Date | null;
  /** Normalized creator identities (handle and display name). */
  creatorKeys: string[];
  phash: string | null;
  tokens: TextTokens;
  /** Observation keys of sightings that pointed at this video (e.g. a Bluesky post URI). */
  references: string[];
}

export type ThumbnailGrade = keyof typeof POINTS.thumbnail | 'unavailable';
export type DurationGrade = keyof typeof POINTS.duration | 'unavailable';
export type TitleGrade = keyof typeof POINTS.title | 'unavailable';
export type PublicationGrade = keyof typeof POINTS.publication | 'unavailable';

export interface DuplicateEvidence {
  thumbnail: {
    grade: ThumbnailGrade;
    distance: number | null;
    similarity: number | null;
    points: number;
  };
  duration: {
    grade: DurationGrade;
    aMs: number | null;
    bMs: number | null;
    differenceMs: number | null;
    differenceRatio: number | null;
    points: number;
  };
  title: {
    grade: TitleGrade;
    similarity: number | null;
    containment: number | null;
    shared: string[];
    numbersConflict: boolean;
    points: number;
  };
  creator: { same: boolean | null; points: number };
  publication: { grade: PublicationGrade; differenceHours: number | null; points: number };
  references: { shared: number; points: number };
}

export type DetectorDecision = 'auto_confirm' | 'possible' | 'no_match';

export interface DuplicateAssessment {
  decision: DetectorDecision;
  confidence: number;
  score: number;
  evidence: DuplicateEvidence;
  /** Positive, independent signals (thumbnail, duration, title, creator). */
  positiveSignals: string[];
  vetoes: string[];
  /** Why a strong-looking pair was NOT auto-confirmed. */
  autoBlockers: string[];
  reasons: string[];
  detectorVersion: string;
}

export function creatorKeys(...values: (string | null | undefined)[]): string[] {
  const keys = new Set<string>();
  for (const v of values) {
    const k = v ? normalizeText(v).replace(/ /g, '') : '';
    if (k.length >= 3) keys.add(k);
  }
  return [...keys];
}

function gradeThumbnail(a: string | null, b: string | null): DuplicateEvidence['thumbnail'] {
  if (!isHash(a) || !isHash(b))
    return { grade: 'unavailable', distance: null, similarity: null, points: 0 };
  const distance = hammingDistance(a, b);
  const t = THRESHOLDS.thumbnail;
  const grade: ThumbnailGrade =
    distance <= t.identical
      ? 'identical'
      : distance <= t.veryClose
        ? 'very_close'
        : distance <= t.similar
          ? 'similar'
          : distance >= t.different
            ? 'different'
            : 'inconclusive';
  return { grade, distance, similarity: round(1 - distance / 64), points: POINTS.thumbnail[grade] };
}

function within(diff: number, longer: number, bound: { ms: number; ratio: number }) {
  return diff <= Math.max(bound.ms, bound.ratio * longer);
}

function gradeDuration(a: number | null, b: number | null): DuplicateEvidence['duration'] {
  if (a === null || b === null || a <= 0 || b <= 0)
    return {
      grade: 'unavailable',
      aMs: a,
      bMs: b,
      differenceMs: null,
      differenceRatio: null,
      points: 0,
    };
  const diff = Math.abs(a - b);
  const longer = Math.max(a, b);
  const d = THRESHOLDS.duration;
  const grade: DurationGrade = within(diff, longer, d.match)
    ? 'match'
    : within(diff, longer, d.close)
      ? 'close'
      : !within(diff, longer, d.different)
        ? 'different'
        : 'inconclusive';
  return {
    grade,
    aMs: a,
    bMs: b,
    differenceMs: diff,
    differenceRatio: round(diff / longer),
    points: POINTS.duration[grade],
  };
}

function gradeTitle(a: TextTokens, b: TextTokens): DuplicateEvidence['title'] {
  const c = compareTokens(a, b);
  if (!c)
    return {
      grade: 'unavailable',
      similarity: null,
      containment: null,
      shared: [],
      numbersConflict: false,
      points: 0,
    };
  const t = THRESHOLDS.title;
  const grade: TitleGrade =
    c.jaccard >= t.strongJaccard ||
    (c.containment >= t.containment && c.shared.length >= t.containmentMin)
      ? 'strong'
      : c.jaccard >= t.moderateJaccard || (c.containment >= 0.6 && c.shared.length >= 2)
        ? 'moderate'
        : c.shared.length >= 2
          ? 'weak'
          : 'none';
  return {
    grade,
    similarity: round(c.jaccard),
    containment: round(c.containment),
    shared: c.shared,
    numbersConflict: c.numbersConflict,
    points: POINTS.title[grade] + (c.numbersConflict ? POINTS.numbersConflict : 0),
  };
}

function gradePublication(a: Date | null, b: Date | null): DuplicateEvidence['publication'] {
  if (!a || !b) return { grade: 'unavailable', differenceHours: null, points: 0 };
  const hours = Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 3_600_000;
  const p = THRESHOLDS.publication;
  const grade: PublicationGrade =
    hours <= p.closeHours ? 'close' : hours <= p.nearHours ? 'near' : 'far';
  return { grade, differenceHours: round(hours, 1), points: POINTS.publication[grade] };
}

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

export function assessPair(a: MatchProfile, b: MatchProfile): DuplicateAssessment {
  const thumbnail = gradeThumbnail(a.phash, b.phash);
  const duration = gradeDuration(a.durationMs, b.durationMs);
  const title = gradeTitle(a.tokens, b.tokens);
  const bKeys = new Set(b.creatorKeys);
  const creatorKnown = a.creatorKeys.length > 0 && b.creatorKeys.length > 0;
  // A different creator is NOT evidence against: reposts are usually by someone else.
  const same = creatorKnown ? a.creatorKeys.some((k) => bKeys.has(k)) : null;
  const creator = { same, points: same ? POINTS.creatorSame : 0 };
  const publication = gradePublication(a.publishedAt, b.publishedAt);
  const bRefs = new Set(b.references);
  const sharedRefs = new Set(a.references.filter((r) => bRefs.has(r))).size;
  const references = { shared: sharedRefs, points: sharedRefs > 0 ? POINTS.sharedReference : 0 };
  const evidence: DuplicateEvidence = {
    thumbnail,
    duration,
    title,
    creator,
    publication,
    references,
  };

  const score =
    thumbnail.points +
    duration.points +
    title.points +
    creator.points +
    publication.points +
    references.points;
  const positiveSignals: string[] = [];
  if (['identical', 'very_close', 'similar'].includes(thumbnail.grade))
    positiveSignals.push('thumbnail');
  if (duration.grade === 'match' || duration.grade === 'close') positiveSignals.push('duration');
  if (title.grade === 'strong' || title.grade === 'moderate') positiveSignals.push('title');
  if (creator.same) positiveSignals.push('creator');

  const vetoes: string[] = [];
  if (duration.grade === 'different') vetoes.push('DURATION_MISMATCH');
  if (thumbnail.grade === 'different' && !positiveSignals.includes('duration'))
    vetoes.push('THUMBNAIL_DIFFERENT_WITHOUT_DURATION_MATCH');

  const reasons = [
    `THUMBNAIL_${thumbnail.grade.toUpperCase()}`,
    `DURATION_${duration.grade.toUpperCase()}`,
    `TITLE_${title.grade.toUpperCase()}`,
    ...(title.numbersConflict ? ['TITLE_NUMBERS_CONFLICT'] : []),
    ...(creator.same ? ['CREATOR_SAME'] : []),
    ...(publication.grade === 'close' ? ['PUBLISHED_CLOSE'] : []),
    ...(references.shared ? ['SHARED_REFERENCE'] : []),
    ...vetoes.map((v) => `VETO_${v}`),
  ];

  const possible =
    vetoes.length === 0 && positiveSignals.length >= 2 && score >= THRESHOLDS.possibleMinScore;
  const autoBlockers: string[] = [];
  if (possible) {
    if (thumbnail.grade !== 'identical' && thumbnail.grade !== 'very_close')
      autoBlockers.push(
        thumbnail.grade === 'unavailable' ? 'NO_THUMBNAIL_HASH' : 'THUMBNAIL_NOT_CLOSE_ENOUGH',
      );
    if (duration.grade !== 'match')
      autoBlockers.push(duration.grade === 'unavailable' ? 'NO_DURATION' : 'DURATION_NOT_EXACT');
    if (!(title.grade === 'strong' || title.grade === 'moderate' || creator.same))
      autoBlockers.push('NO_SUPPORTING_METADATA');
    if (title.numbersConflict) autoBlockers.push('TITLE_NUMBERS_CONFLICT');
    // Same-platform pairs (re-uploads, series episodes) always get a human look.
    if (a.platform === b.platform) autoBlockers.push('SAME_PLATFORM');
    if (score < THRESHOLDS.autoMinScore) autoBlockers.push('SCORE_BELOW_AUTO_THRESHOLD');
  }
  const decision: DetectorDecision = !possible
    ? 'no_match'
    : autoBlockers.length
      ? 'possible'
      : 'auto_confirm';
  return {
    decision,
    confidence: round(Math.min(0.99, Math.max(0, score) / 100)),
    score,
    evidence,
    positiveSignals,
    vetoes,
    autoBlockers,
    reasons: [...reasons, ...autoBlockers.map((b) => `AUTO_BLOCKED_${b}`)],
    detectorVersion: DETECTOR_VERSION,
  };
}

/** One line per signal, for the dashboard and CLI. */
export function summarizeEvidence(e: DuplicateEvidence): string[] {
  const lines: string[] = [];
  lines.push(
    e.thumbnail.grade === 'unavailable'
      ? 'Thumbnail: not comparable (hash unavailable)'
      : `Thumbnail: ${e.thumbnail.grade.replace('_', ' ')} (distance ${e.thumbnail.distance}/64)`,
  );
  lines.push(
    e.duration.grade === 'unavailable'
      ? 'Duration: unknown on at least one side'
      : `Duration: ${e.duration.grade} (${fmtS(e.duration.aMs)} vs ${fmtS(e.duration.bMs)}, Δ ${fmtS(e.duration.differenceMs)})`,
  );
  lines.push(
    e.title.grade === 'unavailable'
      ? 'Title/caption: not comparable'
      : `Title/caption: ${e.title.grade} (similarity ${e.title.similarity}${e.title.shared.length ? `; shared: ${e.title.shared.slice(0, 6).join(', ')}` : ''})${e.title.numbersConflict ? ' — numbers differ' : ''}`,
  );
  if (e.creator.same !== null)
    lines.push(`Creator: ${e.creator.same ? 'same name/handle' : 'different (neutral)'}`);
  if (e.publication.grade !== 'unavailable')
    lines.push(`Published: ${e.publication.differenceHours}h apart (${e.publication.grade})`);
  if (e.references.shared)
    lines.push(`Referenced together by ${e.references.shared} shared post(s)`);
  return lines;
}

function fmtS(ms: number | null) {
  return ms === null ? '—' : `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`;
}
