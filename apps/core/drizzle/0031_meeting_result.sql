ALTER TABLE "core"."meeting" ADD COLUMN "result" text;--> statement-breakpoint
ALTER TABLE "core"."meeting" ADD COLUMN "next_step" text;--> statement-breakpoint
ALTER TABLE "core"."meeting" ADD COLUMN "next_step_on" text;--> statement-breakpoint
ALTER TABLE "core"."meeting" ADD COLUMN "result_source" text;--> statement-breakpoint
ALTER TABLE "core"."meeting" ADD COLUMN "result_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."meeting" ADD COLUMN "expired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."meeting" ADD COLUMN "next_reminded_at" timestamp with time zone;