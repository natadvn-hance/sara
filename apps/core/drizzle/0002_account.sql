CREATE TABLE "core"."account" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"profi_profile_id" text,
	"login_state" text DEFAULT 'unknown' NOT NULL,
	"presence" boolean DEFAULT false NOT NULL,
	"egress_ip" text NOT NULL,
	"balance_rub" integer,
	"balance_at" timestamp with time zone,
	"paused" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
