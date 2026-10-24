CREATE TABLE "core"."direction_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"kind" text NOT NULL,
	"rules" jsonb NOT NULL,
	"rules_hash" text NOT NULL,
	"base_rules" jsonb,
	"base_hash" text,
	"lead_ids" jsonb NOT NULL,
	"seed" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"total" integer NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"stop_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
