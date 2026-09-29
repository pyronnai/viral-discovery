import { createHash } from 'node:crypto';

/**
 * Everything a classifier may look at. Built only from data we already store:
 * no video download, no frame extraction, no page scraping.
 */
export interface ClassificationInput {
  platform: string;
  canonicalUrl: string;
  title: string | null;
  caption: string | null;
  durationMs: number | null;
  publishedAt: string | null;
  creator: { displayName: string | null; handle: string | null } | null;
  /** HTTPS thumbnail URL the provider may fetch itself; null when none is stored. */
  thumbnailUrl: string | null;
  /** Short descriptions of where it was found, e.g. 'search "funny animals"'. */
  discoveryContext: string[];
}

/** What the classifier actually used, recorded on every classification. */
export interface InputsUsed {
  title: boolean;
  caption: boolean;
  creator: boolean;
  duration: boolean;
  discoveryContext: number;
  thumbnail: 'used' | 'unavailable' | 'none';
  /** Why the thumbnail could not be used, when it was unavailable. */
  thumbnailNote?: string;
}

/**
 * Fingerprint of the content-relevant inputs (not scores or metrics). A new
 * fingerprint makes a candidate eligible for reclassification; a score change does not.
 */
export function inputFingerprint(input: ClassificationInput): string {
  const stable = {
    platform: input.platform,
    canonicalUrl: input.canonicalUrl,
    title: input.title,
    caption: input.caption,
    durationMs: input.durationMs,
    creator: input.creator,
    thumbnailUrl: input.thumbnailUrl,
    discoveryContext: [...input.discoveryContext].sort(),
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

/** Only HTTPS URLs are ever passed to a provider for fetching. */
export function usableThumbnail(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}
