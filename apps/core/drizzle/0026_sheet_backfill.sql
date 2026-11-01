ALTER TABLE "core"."sheet_sync" ADD COLUMN "backfill" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."sheet_sync" ADD COLUMN "backfill_message_id" bigint;