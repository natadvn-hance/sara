ALTER TABLE "core"."lead" ADD COLUMN "reposted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."lead" ADD COLUMN "repost_notice" text;