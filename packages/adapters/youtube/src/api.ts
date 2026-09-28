/**
 * Response shapes of the YouTube Data API v3, limited to the fields we read.
 * Verified against https://developers.google.com/youtube/v3/docs/videos (2026-09-16)
 * and .../videos/batchGetStats (2026-09-14). Unknown fields are ignored, and
 * every field that the docs do not guarantee is optional.
 */
import { z } from 'zod';

/** The API serializes unsigned longs as JSON strings; accept numbers too. */
export const Count = z.union([
  z.string().regex(/^\d+$/).transform(Number),
  z.number().int().nonnegative(),
]);

const Thumbnail = z.object({ url: z.url() });

export const VideoResource = z.object({
  kind: z.literal('youtube#video').optional(),
  id: z.string().min(1),
  snippet: z.object({
    publishedAt: z.iso.datetime({ offset: true }).optional(),
    channelId: z.string().min(1),
    title: z.string(),
    description: z.string().optional(),
    thumbnails: z.record(z.string(), Thumbnail).optional(),
    channelTitle: z.string().optional(),
    categoryId: z.string().optional(),
    defaultLanguage: z.string().optional(),
    defaultAudioLanguage: z.string().optional(),
    liveBroadcastContent: z.string().optional(),
  }),
  contentDetails: z.object({ duration: z.string().optional() }).optional(),
  statistics: z
    .object({
      viewCount: Count.optional(),
      likeCount: Count.optional(),
      commentCount: Count.optional(),
    })
    .optional(),
});
export type VideoResource = z.infer<typeof VideoResource>;

export const VideoListResponse = z.object({
  items: z.array(z.unknown()),
  nextPageToken: z.string().optional(),
});

export const BatchGetStatsResponse = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1),
        statistics: z
          .object({
            viewCount: Count.optional(),
            likeCount: Count.optional(),
            commentCount: Count.optional(),
          })
          .optional(),
      }),
    )
    .default([]),
  summary: z.object({ failedVideoIds: z.array(z.string()).default([]) }).optional(),
});

/** Google API error body: {"error": {"code", "message", "errors": [{"reason"}]}}. */
export const GoogleErrorBody = z.object({
  error: z.object({
    code: z.number().optional(),
    message: z.string().optional(),
    errors: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
});
