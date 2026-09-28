import { resolveVideoUrl, type UrlResolution } from '@vd/url-identity';
import {
  expandTikTokShortLink,
  type ShortLinkFailure,
  type ShortLinkOptions,
} from './tiktok-short-links.ts';

export * from './tiktok-short-links.ts';

export type ExpandedResolution =
  | (UrlResolution & { expandedFrom?: undefined })
  | (Extract<UrlResolution, { ok: true }> & { expandedFrom: string })
  | {
      ok: false;
      reason: 'short_link_unresolved';
      failure: ShortLinkFailure;
      platform: 'tiktok';
      message: string;
    };

/**
 * resolveVideoUrl() plus network expansion of allowlisted short links. Pure
 * resolution is tried first; only a recognized TikTok short link triggers requests.
 */
export async function resolveVideoUrlWithExpansion(
  input: string,
  options: ShortLinkOptions = {},
): Promise<ExpandedResolution> {
  const pure = resolveVideoUrl(input);
  if (pure.ok || pure.reason !== 'short_link' || pure.platform !== 'tiktok') return pure;
  const expanded = await expandTikTokShortLink(input, options);
  if (expanded.ok) return { ...expanded.resolved, expandedFrom: input };
  return {
    ok: false,
    reason: 'short_link_unresolved',
    failure: expanded.reason,
    platform: 'tiktok',
    message: `TikTok short link could not be resolved (${expanded.reason}): ${expanded.message}`,
  };
}
