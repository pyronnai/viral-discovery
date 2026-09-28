CREATE TYPE "public"."content_origin" AS ENUM('discovered_external', 'owned_original', 'licensed', 'ai_generated');--> statement-breakpoint
CREATE TYPE "public"."discovery_run_status" AS ENUM('queued', 'running', 'succeeded', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."discovery_run_trigger" AS ENUM('schedule', 'manual');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('approved', 'rejected', 'saved', 'already_used');--> statement-breakpoint
CREATE TYPE "public"."rights_status" AS ENUM('unknown', 'requested', 'granted', 'denied', 'own_content');--> statement-breakpoint
CREATE TYPE "public"."source_query_kind" AS ENUM('search', 'trending', 'channel_feed', 'community_feed');--> statement-breakpoint
CREATE TYPE "public"."video_availability" AS ENUM('available', 'removed', 'private', 'unknown');--> statement-breakpoint
CREATE TABLE "api_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"usage_date" date NOT NULL,
	"quota_bucket" text DEFAULT 'default' NOT NULL,
	"units_used" integer DEFAULT 0 NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"cost_estimate_usd" numeric(12, 4),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_usage_source_date_bucket_uq" UNIQUE("source_id","usage_date","quota_bucket")
);
--> statement-breakpoint
CREATE TABLE "classifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster_id" uuid NOT NULL,
	"taxonomy_version" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"safety_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rationale" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"representative_video_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"platform_creator_id" text NOT NULL,
	"handle" text,
	"display_name" text,
	"profile_url" text,
	"follower_count" bigint,
	"baseline_median_views" bigint,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creators_platform_creator_uq" UNIQUE("platform","platform_creator_id")
);
--> statement-breakpoint
CREATE TABLE "discovery_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"source_query_id" uuid,
	"trigger" "discovery_run_trigger" NOT NULL,
	"status" "discovery_run_status" DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"items_found" integer DEFAULT 0 NOT NULL,
	"items_new" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metric_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"video_id" uuid NOT NULL,
	"source_id" uuid,
	"captured_at" timestamp with time zone NOT NULL,
	"views" bigint,
	"likes" bigint,
	"comments" bigint,
	"shares" bigint,
	"upvotes" bigint,
	"upvote_ratio" real,
	"unavailable" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metric_snapshots_video_captured_uq" UNIQUE("video_id","captured_at"),
	CONSTRAINT "metric_snapshots_ratio_range" CHECK ("metric_snapshots"."upvote_ratio" IS NULL OR ("metric_snapshots"."upvote_ratio" >= 0 AND "metric_snapshots"."upvote_ratio" <= 1))
);
--> statement-breakpoint
CREATE TABLE "review_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster_id" uuid NOT NULL,
	"status" "review_status" NOT NULL,
	"note" text,
	"reviewer" text DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster_id" uuid NOT NULL,
	"video_id" uuid,
	"status" "rights_status" DEFAULT 'unknown' NOT NULL,
	"rights_holder" text,
	"contact" text,
	"license_terms" text,
	"evidence_url" text,
	"requested_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"video_id" uuid NOT NULL,
	"algorithm_version" text NOT NULL,
	"value" double precision NOT NULL,
	"components" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"missing_metrics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"based_on_snapshot_id" uuid,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sightings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"video_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"discovery_run_id" uuid,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"kind" "source_query_kind" NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"region" text,
	"cadence_minutes" integer,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_queries_cadence_positive" CHECK ("source_queries"."cadence_minutes" IS NULL OR "source_queries"."cadence_minutes" > 0)
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"adapter_id" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"daily_quota_budgets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "videos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"platform_video_id" text NOT NULL,
	"canonical_url" text NOT NULL,
	"creator_id" uuid,
	"creator_handle" text,
	"creator_display_name" text,
	"title" text,
	"caption" text,
	"published_at" timestamp with time zone,
	"duration_ms" integer,
	"thumbnail_url" text,
	"thumbnail_phash" text,
	"language" text,
	"content_origin" "content_origin" DEFAULT 'discovered_external' NOT NULL,
	"availability" "video_availability" DEFAULT 'available' NOT NULL,
	"cluster_id" uuid,
	"raw_payload" jsonb,
	"raw_payload_fetched_at" timestamp with time zone,
	"first_discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "videos_platform_video_uq" UNIQUE("platform","platform_video_id"),
	CONSTRAINT "videos_duration_nonneg" CHECK ("videos"."duration_ms" IS NULL OR "videos"."duration_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "api_usage" ADD CONSTRAINT "api_usage_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clusters" ADD CONSTRAINT "clusters_representative_video_id_videos_id_fk" FOREIGN KEY ("representative_video_id") REFERENCES "public"."videos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_source_query_id_source_queries_id_fk" FOREIGN KEY ("source_query_id") REFERENCES "public"."source_queries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_snapshots" ADD CONSTRAINT "metric_snapshots_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_snapshots" ADD CONSTRAINT "metric_snapshots_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rights" ADD CONSTRAINT "rights_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rights" ADD CONSTRAINT "rights_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_based_on_snapshot_id_metric_snapshots_id_fk" FOREIGN KEY ("based_on_snapshot_id") REFERENCES "public"."metric_snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sightings" ADD CONSTRAINT "sightings_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sightings" ADD CONSTRAINT "sightings_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sightings" ADD CONSTRAINT "sightings_discovery_run_id_discovery_runs_id_fk" FOREIGN KEY ("discovery_run_id") REFERENCES "public"."discovery_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_queries" ADD CONSTRAINT "source_queries_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "videos" ADD CONSTRAINT "videos_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "videos" ADD CONSTRAINT "videos_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "classifications_cluster_id_idx" ON "classifications" USING btree ("cluster_id");--> statement-breakpoint
CREATE INDEX "discovery_runs_source_id_idx" ON "discovery_runs" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "review_events_cluster_id_idx" ON "review_events" USING btree ("cluster_id");--> statement-breakpoint
CREATE INDEX "rights_cluster_id_idx" ON "rights" USING btree ("cluster_id");--> statement-breakpoint
CREATE INDEX "scores_video_id_idx" ON "scores" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "sightings_video_id_idx" ON "sightings" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "source_queries_source_id_idx" ON "source_queries" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "videos_cluster_id_idx" ON "videos" USING btree ("cluster_id");