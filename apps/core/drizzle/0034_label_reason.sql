ALTER TABLE "core"."lead_label" ADD COLUMN "reason_code" text;--> statement-breakpoint
ALTER TABLE "core"."lead_label" ADD COLUMN "reason_detail" text;--> statement-breakpoint
ALTER TABLE "core"."lead_label" ADD COLUMN "reason_by" text;--> statement-breakpoint
ALTER TABLE "core"."lead_label" ADD COLUMN "guess_code" text;--> statement-breakpoint
ALTER TABLE "core"."lead_label" ADD COLUMN "reason_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."lead_score" ADD COLUMN "precedents" jsonb;--> statement-breakpoint
ALTER TABLE "core"."rule_proposal" ADD COLUMN "reason_code" text;--> statement-breakpoint
ALTER TABLE "core"."rule_proposal" ADD COLUMN "reason_detail" text;