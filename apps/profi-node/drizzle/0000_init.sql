CREATE SCHEMA "node";
--> statement-breakpoint
CREATE TABLE "node"."outbox_node" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_try_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"dead_reason" text
);
--> statement-breakpoint
CREATE TABLE "node"."raw_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"kind" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"url" text,
	"body" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "node"."raw_message" (
	"platform_message_id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"account_id" text NOT NULL,
	"order_id" text,
	"author" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"text" text NOT NULL,
	"read" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "node"."raw_order" (
	"order_id" text NOT NULL,
	"account_id" text NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	"body" jsonb NOT NULL,
	CONSTRAINT "raw_order_order_id_account_id_pk" PRIMARY KEY("order_id","account_id")
);
--> statement-breakpoint
CREATE INDEX "outbox_node_due_idx" ON "node"."outbox_node" USING btree ("confirmed_at","next_try_at");--> statement-breakpoint
CREATE INDEX "raw_event_received_idx" ON "node"."raw_event" USING btree ("received_at");