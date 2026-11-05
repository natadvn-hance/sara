CREATE TABLE "core"."analytics_hypothesis" (
	"id" uuid PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"level" text NOT NULL,
	"status" text NOT NULL,
	"text" text NOT NULL,
	"facts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "core"."telegram_forum" ADD COLUMN "analytics_thread_id" integer;