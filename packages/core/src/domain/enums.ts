import { z } from 'zod';

/**
 * Platform identifier. Deliberately an open, validated string rather than a closed
 * enum: adding or removing a source adapter must never require editing core.
 * Examples: "youtube", "reddit", "tiktok", "manual".
 */
export const PlatformIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{1,31}$/, 'platform id must be lowercase, 2-32 chars');
export type PlatformId = z.infer<typeof PlatformIdSchema>;

/**
 * How a piece of content entered the system. This is about ORIGIN, not permission.
 * Permission to republish lives in RightsRecord.
 * - discovered_external: found on a third-party platform; we hold metadata + links only.
 * - owned_original:      created by the operator (you); you own it.
 * - licensed:            media obtained directly from a rights holder under a license.
 * - ai_generated:        synthetic media produced by a generation tool (none integrated yet).
 */
export const CONTENT_ORIGINS = [
  'discovered_external',
  'owned_original',
  'licensed',
  'ai_generated',
] as const;
export const ContentOriginSchema = z.enum(CONTENT_ORIGINS);
export type ContentOrigin = z.infer<typeof ContentOriginSchema>;

/** Rights / permission-to-republish status. Discovery never implies permission. */
export const RIGHTS_STATUSES = [
  'unknown',
  'requested',
  'granted',
  'denied',
  'own_content',
] as const;
export const RightsStatusSchema = z.enum(RIGHTS_STATUSES);
export type RightsStatus = z.infer<typeof RightsStatusSchema>;

export const REVIEW_STATUSES = ['approved', 'rejected', 'saved', 'already_used'] as const;
export const ReviewStatusSchema = z.enum(REVIEW_STATUSES);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

export const DISCOVERY_RUN_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'partial',
  'failed',
] as const;
export const DiscoveryRunStatusSchema = z.enum(DISCOVERY_RUN_STATUSES);
export type DiscoveryRunStatus = z.infer<typeof DiscoveryRunStatusSchema>;

export const DISCOVERY_RUN_TRIGGERS = ['schedule', 'manual'] as const;
export const DiscoveryRunTriggerSchema = z.enum(DISCOVERY_RUN_TRIGGERS);
export type DiscoveryRunTrigger = z.infer<typeof DiscoveryRunTriggerSchema>;

/** What a SourceQuery asks an adapter to do. */
export const SOURCE_QUERY_KINDS = [
  'search', // keyword/topic search
  'trending', // platform-provided popularity chart/listing
  'channel_feed', // latest uploads from a known account/channel
  'community_feed', // a community listing, e.g. a subreddit
] as const;
export const SourceQueryKindSchema = z.enum(SOURCE_QUERY_KINDS);
export type SourceQueryKind = z.infer<typeof SourceQueryKindSchema>;

/** Whether the upstream item is still publicly reachable, as last observed. */
export const VIDEO_AVAILABILITIES = ['available', 'removed', 'private', 'unknown'] as const;
export const VideoAvailabilitySchema = z.enum(VIDEO_AVAILABILITIES);
export type VideoAvailability = z.infer<typeof VideoAvailabilitySchema>;
