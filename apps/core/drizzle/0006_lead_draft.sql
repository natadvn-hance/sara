ALTER TABLE "core"."lead" ADD COLUMN "draft_text" text;--> statement-breakpoint
ALTER TABLE "core"."lead" ADD COLUMN "draft_price_rub" integer;--> statement-breakpoint
ALTER TABLE "core"."lead" ADD COLUMN "draft_analysis" jsonb;