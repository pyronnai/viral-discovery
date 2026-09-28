ALTER TABLE "discovery_runs" ADD COLUMN "request" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD COLUMN "stats" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sightings" ADD COLUMN "observation_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sightings" ADD CONSTRAINT "sightings_run_video_observation_uq" UNIQUE("discovery_run_id","video_id","observation_key");