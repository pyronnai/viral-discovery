import { z } from 'zod';
import {
  ContentOriginSchema,
  MetricReadingsSchema,
  PlatformIdSchema,
  VideoAvailabilitySchema,
} from '@vd/core';

const httpUrl = z.url({ protocol: /^https?$/ });

/** Raw item as returned by an adapter before normalization. Payload stays opaque to core. */
export const RawItemSchema = z.object({
  adapterId: z.string().min(1),
  /** The platform's id for the item (video id, post id, …). */
  externalId: z.string().min(1),
  fetchedAt: z.date(),
  payload: z.unknown(),
  /** Discovery context, e.g. {"subreddit": "funny", "rank": 3}. Becomes Sighting.context. */
  context: z.record(z.string(), z.unknown()).default({}),
});
export type RawItem = z.infer<typeof RawItemSchema>;

export const NormalizedCreatorSchema = z.object({
  platform: PlatformIdSchema,
  /** Stable platform id. null when the platform exposes only a display name. */
  platformCreatorId: z.string().min(1).nullable(),
  handle: z.string().min(1).nullable(),
  displayName: z.string().min(1).nullable(),
  profileUrl: httpUrl.nullable(),
  followerCount: z.number().int().nonnegative().nullable().default(null),
});
export type NormalizedCreator = z.infer<typeof NormalizedCreatorSchema>;

/**
 * The single normalized shape every adapter must produce. Core never sees
 * platform-specific payloads. Unknown values are explicit nulls, never guesses.
 */
export const NormalizedVideoSchema = z.object({
  platform: PlatformIdSchema,
  platformVideoId: z.string().min(1),
  canonicalUrl: httpUrl,
  creator: NormalizedCreatorSchema.nullable(),
  title: z.string().nullable(),
  caption: z.string().nullable(),
  publishedAt: z.date().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  thumbnailUrl: httpUrl.nullable(),
  language: z.string().min(2).max(16).nullable().default(null),
  contentOrigin: ContentOriginSchema.default('discovered_external'),
  availability: VideoAvailabilitySchema.default('available'),
  /** Metrics observed together with the item, if any. null = none observed this time. */
  metrics: MetricReadingsSchema.nullable(),
  observedAt: z.date(),
});
export type NormalizedVideo = z.infer<typeof NormalizedVideoSchema>;
export type NormalizedVideoInput = z.input<typeof NormalizedVideoSchema>;

export const MetricRefreshResultSchema = z.object({
  platformVideoId: z.string().min(1),
  availability: VideoAvailabilitySchema,
  metrics: MetricReadingsSchema.nullable(),
  observedAt: z.date(),
});
export type MetricRefreshResult = z.infer<typeof MetricRefreshResultSchema>;
