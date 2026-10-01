CREATE TYPE "public"."duplicate_status" AS ENUM('possible', 'auto_confirmed', 'confirmed', 'rejected');--> statement-breakpoint
CREATE TABLE "cluster_merges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"survivor_cluster_id" uuid NOT NULL,
	"absorbed_cluster_id" uuid NOT NULL,
	"duplicate_candidate_id" uuid,
	"trigger" text NOT NULL,
	"representative_video_id" uuid,
	"review_conflict" boolean DEFAULT false NOT NULL,
	"rights_conflict" boolean DEFAULT false NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"merged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "duplicate_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"video_a_id" uuid NOT NULL,
	"video_b_id" uuid NOT NULL,
	"status" "duplicate_status" DEFAULT 'possible' NOT NULL,
	"confidence" real NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"detector_version" text NOT NULL,
	"first_detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"note" text,
	CONSTRAINT "duplicate_candidates_pair_uq" UNIQUE("video_a_id","video_b_id"),
	CONSTRAINT "duplicate_candidates_ordered_pair" CHECK ("duplicate_candidates"."video_a_id" < "duplicate_candidates"."video_b_id"),
	CONSTRAINT "duplicate_candidates_confidence_range" CHECK ("duplicate_candidates"."confidence" >= 0 AND "duplicate_candidates"."confidence" <= 1)
);
--> statement-breakpoint
ALTER TABLE "clusters" ADD COLUMN "merged_into_cluster_id" uuid;--> statement-breakpoint
ALTER TABLE "clusters" ADD COLUMN "merged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review_events" ADD COLUMN "origin_cluster_id" uuid;--> statement-breakpoint
ALTER TABLE "rights" ADD COLUMN "origin_cluster_id" uuid;--> statement-breakpoint
ALTER TABLE "videos" ADD COLUMN "thumbnail_hash_status" text;--> statement-breakpoint
ALTER TABLE "videos" ADD COLUMN "thumbnail_hash_url" text;--> statement-breakpoint
ALTER TABLE "videos" ADD COLUMN "thumbnail_hashed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "videos" ADD COLUMN "thumbnail_hash_bands" text[];--> statement-breakpoint
ALTER TABLE "videos" ADD COLUMN "match_tokens" text[];--> statement-breakpoint
ALTER TABLE "videos" ADD COLUMN "duplicate_scanned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cluster_merges" ADD CONSTRAINT "cluster_merges_survivor_cluster_id_clusters_id_fk" FOREIGN KEY ("survivor_cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_merges" ADD CONSTRAINT "cluster_merges_absorbed_cluster_id_clusters_id_fk" FOREIGN KEY ("absorbed_cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_merges" ADD CONSTRAINT "cluster_merges_duplicate_candidate_id_duplicate_candidates_id_fk" FOREIGN KEY ("duplicate_candidate_id") REFERENCES "public"."duplicate_candidates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_merges" ADD CONSTRAINT "cluster_merges_representative_video_id_videos_id_fk" FOREIGN KEY ("representative_video_id") REFERENCES "public"."videos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_video_a_id_videos_id_fk" FOREIGN KEY ("video_a_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_video_b_id_videos_id_fk" FOREIGN KEY ("video_b_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cluster_merges_survivor_idx" ON "cluster_merges" USING btree ("survivor_cluster_id","merged_at");--> statement-breakpoint
CREATE INDEX "cluster_merges_absorbed_idx" ON "cluster_merges" USING btree ("absorbed_cluster_id");--> statement-breakpoint
CREATE INDEX "duplicate_candidates_video_b_idx" ON "duplicate_candidates" USING btree ("video_b_id");--> statement-breakpoint
CREATE INDEX "duplicate_candidates_status_idx" ON "duplicate_candidates" USING btree ("status");--> statement-breakpoint
ALTER TABLE "clusters" ADD CONSTRAINT "clusters_merged_into_cluster_id_clusters_id_fk" FOREIGN KEY ("merged_into_cluster_id") REFERENCES "public"."clusters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_origin_cluster_id_clusters_id_fk" FOREIGN KEY ("origin_cluster_id") REFERENCES "public"."clusters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rights" ADD CONSTRAINT "rights_origin_cluster_id_clusters_id_fk" FOREIGN KEY ("origin_cluster_id") REFERENCES "public"."clusters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "videos_duration_idx" ON "videos" USING btree ("duration_ms");--> statement-breakpoint
CREATE INDEX "videos_hash_bands_idx" ON "videos" USING gin ("thumbnail_hash_bands");--> statement-breakpoint
CREATE INDEX "videos_match_tokens_idx" ON "videos" USING gin ("match_tokens");--> statement-breakpoint
CREATE INDEX "videos_duplicate_scanned_idx" ON "videos" USING btree ("duplicate_scanned_at");