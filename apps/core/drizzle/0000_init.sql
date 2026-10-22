CREATE SCHEMA "core";
--> statement-breakpoint
CREATE TABLE "core"."deal" (
	"id" uuid PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"account_id" text NOT NULL,
	"stage" text NOT NULL,
	"owner" text DEFAULT 'sara' NOT NULL,
	"turn" text DEFAULT 'client' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deal_lead_id_unique" UNIQUE("lead_id")
);
--> statement-breakpoint
CREATE TABLE "core"."event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"v" integer NOT NULL,
	"entity_kind" text NOT NULL,
	"entity_id" text NOT NULL,
	"account_id" text,
	"actor" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"causation_id" uuid,
	"correlation_id" uuid NOT NULL,
	"reason" text,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."lead" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"city" text NOT NULL,
	"text" text NOT NULL,
	"client_name" text NOT NULL,
	"budget_text" text,
	"bid_price_rub" integer NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"correlation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."model_call" (
	"id" uuid PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"role_version" integer NOT NULL,
	"model" text NOT NULL,
	"priority" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"ok" boolean NOT NULL,
	"error_class" text,
	"pseudonymized" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"confirmed_at" timestamp with time zone,
	"error_class" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "core"."owner_auth" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"password_hash" text,
	"telegram_chat_id" bigint,
	"telegram_user_id" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_auth_single_row" CHECK ("core"."owner_auth"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "core"."setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"changed_by" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."setting_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"changed_by" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."task" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"entity_kind" text NOT NULL,
	"entity_id" text NOT NULL,
	"priority" text DEFAULT 'P1' NOT NULL,
	"due_at" timestamp with time zone,
	"state" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"resolved_at" timestamp with time zone,
	"telegram_message_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."deal" ADD CONSTRAINT "deal_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "core"."lead"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_entity_idx" ON "core"."event" USING btree ("entity_kind","entity_id");--> statement-breakpoint
CREATE INDEX "event_correlation_idx" ON "core"."event" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "event_type_idx" ON "core"."event" USING btree ("type","occurred_at");