CREATE TABLE "core"."meeting" (
	"id" uuid PRIMARY KEY NOT NULL,
	"deal_id" uuid NOT NULL,
	"conversation_id" uuid,
	"account_id" text NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"starts_at" timestamp with time zone,
	"duration_min" integer NOT NULL,
	"channel" text,
	"channel_note" text,
	"offered" jsonb,
	"offer_sent_at" timestamp with time zone,
	"confirming_at" timestamp with time zone,
	"announced_at" timestamp with time zone,
	"announce_message_id" bigint,
	"round_key" text,
	"moved_from" uuid,
	"clock_version" integer DEFAULT 0 NOT NULL,
	"phone" text,
	"phone_purge_at" timestamp with time zone,
	"brief" jsonb,
	"also_asked" text,
	"booked_at" timestamp with time zone,
	"morning_sent_at" timestamp with time zone,
	"before_sent_at" timestamp with time zone,
	"outcome_asked_at" timestamp with time zone,
	"outcome_at" timestamp with time zone,
	"outcome_nudges" integer DEFAULT 0 NOT NULL,
	"amount_nudges" integer DEFAULT 0 NOT NULL,
	"thinking_nudges" integer DEFAULT 0 NOT NULL,
	"cancelled_by" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."meeting_turn" (
	"round_key" text PRIMARY KEY NOT NULL,
	"meeting_id" uuid,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."v1_bid" (
	"order_id" text NOT NULL,
	"account_id" text NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	"fee_rub" integer,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "v1_bid_order_id_account_id_pk" PRIMARY KEY("order_id","account_id")
);
--> statement-breakpoint
ALTER TABLE "core"."deal" ALTER COLUMN "lead_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."deal" ADD COLUMN "order_id" text;--> statement-breakpoint
ALTER TABLE "core"."deal" ADD COLUMN "origin" text DEFAULT 'sara' NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."deal" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "core"."deal" ADD COLUMN "amount_rub" integer;--> statement-breakpoint
ALTER TABLE "core"."deal" ADD COLUMN "outcome_reason" text;--> statement-breakpoint
ALTER TABLE "core"."deal" ADD COLUMN "outcome_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."meeting" ADD CONSTRAINT "meeting_deal_id_deal_id_fk" FOREIGN KEY ("deal_id") REFERENCES "core"."deal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_one_active" ON "core"."meeting" USING btree ("deal_id") WHERE "core"."meeting"."state" in ('offered', 'confirming', 'booked');--> statement-breakpoint
CREATE INDEX "meeting_state_starts" ON "core"."meeting" USING btree ("state","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "deal_account_order" ON "core"."deal" USING btree ("account_id","order_id");--> statement-breakpoint
UPDATE "core"."deal" SET "order_id" = "lead_id" WHERE "order_id" IS NULL;
