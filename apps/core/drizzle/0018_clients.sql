CREATE TABLE "core"."meeting" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid,
	"title" text NOT NULL,
	"starts_at" timestamp with time zone,
	"channel" text,
	"note" text,
	"outcome" text,
	"amount_rub" integer,
	"created_by" text DEFAULT 'boris' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."conversation" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "core"."conversation" ADD COLUMN "service" text;--> statement-breakpoint
ALTER TABLE "core"."conversation" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "core"."conversation" ADD COLUMN "outcome_reason" text;--> statement-breakpoint
ALTER TABLE "core"."conversation" ADD COLUMN "amount_rub" integer;--> statement-breakpoint
ALTER TABLE "core"."conversation" ADD COLUMN "outcome_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "meeting_starts" ON "core"."meeting" USING btree ("starts_at");