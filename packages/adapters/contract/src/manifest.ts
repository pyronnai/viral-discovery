import { z } from 'zod';
import { MetricKeySchema, PlatformIdSchema } from '@vd/core';

/**
 * Capabilities an adapter may implement. Adapters support different subsets.
 * `normalize` is mandatory for every adapter.
 */
export const AdapterCapabilitySchema = z.enum([
  'discovery.search', // keyword/topic search            → SourceQuery kind "search"
  'discovery.trending', // platform popularity listings → SourceQuery kind "trending"
  'discovery.feed', // channel/community feeds           → kinds "channel_feed" | "community_feed"
  'discovery.url', // resolve a single submitted URL (manual submission, link resolution)
  'metrics.refresh', // re-fetch engagement metrics for known videos
  'creator.enrich', // fetch creator/account details
  'normalize', // map raw payloads to NormalizedVideo (required)
]);
export type AdapterCapability = z.infer<typeof AdapterCapabilitySchema>;

export const AccessMethodSchema = z.enum([
  'official_api', // documented, authenticated platform API
  'official_feed', // documented public feed (e.g. RSS/Atom published by the platform)
  'oembed', // documented oEmbed endpoint
  'manual', // human-supplied input
]);
export type AccessMethod = z.infer<typeof AccessMethodSchema>;

export const QuotaBucketSchema = z.object({
  /** Bucket name as the platform accounts for it, e.g. "search.list" or "default". */
  name: z.string().min(1),
  /** Unit of measure, e.g. "units", "requests". */
  unit: z.string().min(1),
  /**
   * Default daily budget, or null when not verified. Real budgets come from the
   * Source row (sources.daily_quota_budgets) so they stay configurable.
   */
  defaultDailyBudget: z.number().int().positive().nullable(),
  notes: z.string().optional(),
});
export type QuotaBucket = z.infer<typeof QuotaBucketSchema>;

export const AdapterManifestSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,47}$/, 'adapter id must be kebab-case'),
    platform: PlatformIdSchema,
    displayName: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be semver x.y.z'),
    accessMethod: AccessMethodSchema,
    capabilities: z.array(AdapterCapabilitySchema).min(1),
    /** Metrics this adapter can actually return. Anything else must be reported unavailable. */
    metricsProvided: z.array(MetricKeySchema),
    quotaBuckets: z.array(QuotaBucketSchema).default([]),
    /** Env var names the adapter needs. Values are never stored in the manifest. */
    requiredEnv: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).default([]),
    /** Relative path of the compliance/access doc, e.g. "docs/sources/youtube.md". */
    docsPath: z.string().min(1),
  })
  .superRefine((m, ctx) => {
    if (!m.capabilities.includes('normalize')) {
      ctx.addIssue({ code: 'custom', path: ['capabilities'], message: '"normalize" is required' });
    }
    if (new Set(m.capabilities).size !== m.capabilities.length) {
      ctx.addIssue({ code: 'custom', path: ['capabilities'], message: 'duplicate capability' });
    }
  });
export type AdapterManifest = z.infer<typeof AdapterManifestSchema>;
export type AdapterManifestInput = z.input<typeof AdapterManifestSchema>;
