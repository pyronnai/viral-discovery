/**
 * Feed filters <-> URL search params, so every view is shareable and reloadable.
 * Unknown or malformed values are ignored rather than erroring.
 */
import { CONTENT_LABELS } from '@vd/classification';
import { RIGHTS_STATUSES } from '@vd/core';
import { REVIEW_FILTERS, STATE_FILTERS, type FeedFilters } from '@vd/review';

export type SearchParams = Record<string, string | string[] | undefined>;

function one(params: SearchParams, key: string): string | undefined {
  const v = params[key];
  const s = Array.isArray(v) ? v[0] : v;
  return s?.trim() ? s.trim() : undefined;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function positive(value: string | undefined, max: number): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= max ? n : undefined;
}

export function parseFilters(params: SearchParams): FeedFilters {
  const slug = (v: string | undefined) => (v && /^[a-z0-9_.-]{1,64}$/i.test(v) ? v : undefined);
  return {
    review: oneOf(one(params, 'review'), REVIEW_FILTERS),
    label: oneOf(one(params, 'label'), CONTENT_LABELS),
    platform: slug(one(params, 'platform')),
    source: slug(one(params, 'source')),
    state: oneOf(one(params, 'state'), STATE_FILTERS),
    minScore: positive(one(params, 'minScore'), 100),
    discoveredWithinHours: positive(one(params, 'within'), 24 * 365),
    rights: oneOf(one(params, 'rights'), [...RIGHTS_STATUSES, 'conflict'] as const),
    flagged: one(params, 'flagged') === '1' ? true : undefined,
    possibleDuplicates: one(params, 'dups') === '1' ? true : undefined,
  };
}

/** Builds a feed URL from filters (+ optional cursor), omitting empty values. */
export function feedHref(filters: FeedFilters, cursor?: string | null): string {
  const q = new URLSearchParams();
  if (filters.review) q.set('review', filters.review);
  if (filters.label) q.set('label', filters.label);
  if (filters.platform) q.set('platform', filters.platform);
  if (filters.source) q.set('source', filters.source);
  if (filters.state) q.set('state', filters.state);
  if (filters.minScore !== undefined) q.set('minScore', String(filters.minScore));
  if (filters.discoveredWithinHours !== undefined)
    q.set('within', String(filters.discoveredWithinHours));
  if (filters.rights) q.set('rights', filters.rights);
  if (filters.flagged) q.set('flagged', '1');
  if (filters.possibleDuplicates) q.set('dups', '1');
  if (cursor) q.set('cursor', cursor);
  const s = q.toString();
  return s ? `/?${s}` : '/';
}

export function hasFilters(filters: FeedFilters): boolean {
  return Object.values(filters).some((v) => v !== undefined);
}
