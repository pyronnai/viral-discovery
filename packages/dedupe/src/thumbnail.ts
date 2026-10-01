import { fetchThumbnail, type FetchFailure, type FetchPolicy, type HopTransport } from './fetch.ts';
import { decodeImage } from './image.ts';
import { perceptualHash } from './phash.ts';

export type ThumbnailHashStatus =
  'hashed' | 'uninformative' | 'no_thumbnail' | 'decode_failed' | FetchFailure;

export interface ThumbnailHashResult {
  status: ThumbnailHashStatus;
  hash: string | null;
  reason: string | null;
}

/** url → hash. Never throws: every failure becomes a status (detection continues without it). */
export type ThumbnailHasher = (url: string) => Promise<ThumbnailHashResult>;

export function hashImageBytes(bytes: Uint8Array): ThumbnailHashResult {
  const decoded = decodeImage(bytes);
  if (!decoded.ok) return { status: decoded.status, hash: null, reason: decoded.reason };
  const outcome = perceptualHash(decoded.image);
  return outcome.kind === 'hashed'
    ? { status: 'hashed', hash: outcome.hash, reason: null }
    : { status: 'uninformative', hash: null, reason: 'image is nearly uniform' };
}

export function createThumbnailHasher(
  options: { policy?: FetchPolicy; transport?: HopTransport } = {},
): ThumbnailHasher {
  return async (url) => {
    try {
      const fetched = await fetchThumbnail(url, options);
      if (!fetched.ok) return { status: fetched.status, hash: null, reason: fetched.reason };
      return hashImageBytes(fetched.bytes);
    } catch (err) {
      return {
        status: 'fetch_failed',
        hash: null,
        reason: err instanceof Error ? err.message.slice(0, 200) : 'failed',
      };
    }
  };
}
