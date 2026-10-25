CREATE TABLE "core"."direction_onboarding" (
	"account_id" text PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"based_on_version" integer,
	"draft" jsonb NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."direction_override" (
	"account_id" text NOT NULL,
	"version" integer NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "direction_override_account_id_version_pk" PRIMARY KEY("account_id","version")
);
