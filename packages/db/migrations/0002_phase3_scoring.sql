CREATE TYPE "public"."score_state" AS ENUM('scored', 'provisional', 'insufficient_evidence');--> statement-breakpoint
ALTER TABLE "scores" ALTER COLUMN "value" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "scores" ADD COLUMN "state" "score_state" DEFAULT 'scored' NOT NULL;--> statement-breakpoint
ALTER TABLE "scores" ADD COLUMN "confidence" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scores" ADD COLUMN "reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "scores" ADD COLUMN "inputs_hash" text;--> statement-breakpoint
CREATE INDEX "discovery_runs_query_created_idx" ON "discovery_runs" USING btree ("source_query_id","created_at");--> statement-breakpoint
CREATE INDEX "scores_video_version_computed_idx" ON "scores" USING btree ("video_id","algorithm_version","computed_at");--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_value_matches_state" CHECK (("scores"."state" = 'insufficient_evidence') = ("scores"."value" IS NULL));--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_confidence_range" CHECK ("scores"."confidence" >= 0 AND "scores"."confidence" <= 1);