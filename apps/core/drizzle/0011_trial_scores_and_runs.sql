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
--> statement-breakpoint
CREATE TABLE "core"."trial_score" (
	"rules_hash" text NOT NULL,
	"lead_id" text NOT NULL,
	"mode" text NOT NULL,
	"role_version" integer NOT NULL,
	"score" integer NOT NULL,
	"decision" text NOT NULL,
	"stop_factor" text,
	"red_flags" jsonb NOT NULL,
	"axes" jsonb NOT NULL,
	"reason" text NOT NULL,
	"confidence" real NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trial_score_rules_hash_lead_id_mode_role_version_pk" PRIMARY KEY("rules_hash","lead_id","mode","role_version")
);
