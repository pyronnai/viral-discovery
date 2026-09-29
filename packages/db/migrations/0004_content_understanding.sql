CREATE TABLE "classification_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster_id" uuid NOT NULL,
	"video_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"taxonomy_version" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input_hash" text NOT NULL,
	"error_kind" text NOT NULL,
	"error" text NOT NULL,
	"details" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"retryable" boolean DEFAULT false NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "classifications" ADD COLUMN "video_id" uuid;--> statement-breakpoint
ALTER TABLE "classifications" ADD COLUMN "provider" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "classifications" ADD COLUMN "analysis" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "classifications" ADD COLUMN "inputs_used" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "classifications" ADD COLUMN "input_hash" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "classification_failures" ADD CONSTRAINT "classification_failures_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classification_failures" ADD CONSTRAINT "classification_failures_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "classification_failures_cluster_idx" ON "classification_failures" USING btree ("cluster_id","attempted_at");--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "classifications_cluster_version_idx" ON "classifications" USING btree ("cluster_id","taxonomy_version","prompt_version","created_at");--> statement-breakpoint
-- Data backfill: every video belongs to a cluster so review and classification can
-- operate per cluster. Clusters start as singletons (exact identity only); near-duplicate
-- clustering is not implemented yet.
WITH missing AS (
  SELECT id FROM "videos" WHERE "cluster_id" IS NULL
), created AS (
  INSERT INTO "clusters" ("representative_video_id")
  SELECT id FROM missing
  RETURNING id, representative_video_id
)
UPDATE "videos" v SET "cluster_id" = c.id FROM created c WHERE v.id = c.representative_video_id;
