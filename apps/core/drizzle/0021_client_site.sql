CREATE TABLE "core"."site_cache" (
	"domain" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"deep" boolean DEFAULT false NOT NULL,
	"cms" text,
	"signals" jsonb,
	"pages" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."lead" ADD COLUMN "client_site" jsonb;