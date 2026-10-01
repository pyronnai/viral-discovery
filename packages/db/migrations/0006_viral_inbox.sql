CREATE TYPE "public"."acquisition_status" AS ENUM('obtained', 'not_obtained');--> statement-breakpoint
ALTER TYPE "public"."review_status" ADD VALUE 'cleared';--> statement-breakpoint
CREATE TABLE "acquisition_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster_id" uuid NOT NULL,
	"status" "acquisition_status" NOT NULL,
	"video_id" uuid,
	"note" text,
	"origin_cluster_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"video_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"url" text NOT NULL,
	"provider" text NOT NULL,
	"license_note" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_assets_video_url_uq" UNIQUE("video_id","url")
);
--> statement-breakpoint
ALTER TABLE "acquisition_events" ADD CONSTRAINT "acquisition_events_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquisition_events" ADD CONSTRAINT "acquisition_events_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquisition_events" ADD CONSTRAINT "acquisition_events_origin_cluster_id_clusters_id_fk" FOREIGN KEY ("origin_cluster_id") REFERENCES "public"."clusters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "acquisition_events_cluster_idx" ON "acquisition_events" USING btree ("cluster_id","created_at");