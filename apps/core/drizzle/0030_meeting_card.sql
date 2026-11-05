ALTER TABLE "core"."meeting" ADD COLUMN "status" text DEFAULT 'booked' NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."meeting" ADD COLUMN "source" text DEFAULT 'boris' NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."meeting" ADD COLUMN "how" text;--> statement-breakpoint
ALTER TABLE "core"."meeting" ADD COLUMN "caller" text;--> statement-breakpoint
ALTER TABLE "core"."meeting" ADD COLUMN "quote" text;--> statement-breakpoint
ALTER TABLE "core"."meeting" ADD COLUMN "card_ref" bigint;