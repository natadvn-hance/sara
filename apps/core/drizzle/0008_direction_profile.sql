CREATE TABLE "core"."direction_profile" (
	"account_id" text PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'on' NOT NULL,
	"speed" text DEFAULT 'normal' NOT NULL,
	"reply_format" jsonb,
	"cases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
