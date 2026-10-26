CREATE TABLE "core"."lead_candidate" (
	"order_id" text NOT NULL,
	"account_id" text NOT NULL,
	"score" integer,
	"decision" text NOT NULL,
	"stop_factor" text,
	"margin" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_candidate_order_id_account_id_pk" PRIMARY KEY("order_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "core"."lead_route" (
	"order_id" text PRIMARY KEY NOT NULL,
	"account_id" text,
	"state" text NOT NULL,
	"needs_choice" boolean DEFAULT false NOT NULL,
	"alternatives" jsonb NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_one_bid_per_order" ON "core"."outbox" USING btree (("payload"->>'leadId')) WHERE "core"."outbox"."kind" = 'bid';