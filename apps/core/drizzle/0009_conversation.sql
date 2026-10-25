-- Custom SQL: the mind index keeps local vectors (pgvector, M4 design 5.3).
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "core"."chat_message" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"order_id" text,
	"platform_message_id" text NOT NULL,
	"side" text NOT NULL,
	"author" text NOT NULL,
	"author_basis" text NOT NULL,
	"text" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"approx_time" boolean DEFAULT false NOT NULL,
	"read" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"conversation_id" uuid,
	"heard_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."conv_turn" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"kind" text DEFAULT 'reply' NOT NULL,
	"anchor_message_id" text NOT NULL,
	"message_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'started' NOT NULL,
	"mind_version" text,
	"recalled" jsonb,
	"understanding" jsonb,
	"move" text,
	"urgent" boolean DEFAULT false NOT NULL,
	"text" text,
	"fact_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"example_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"missing" text,
	"checks" jsonb,
	"decision" text,
	"decision_reason" text,
	"outcome" text,
	"model_call_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"task_id" uuid,
	"card_message_id" bigint,
	"boris_text" text,
	"actual_message_id" text,
	"actual_author" text,
	"similarity" integer,
	"timings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "core"."conversation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"order_id" text,
	"deal_id" uuid,
	"origin" text DEFAULT 'v1' NOT NULL,
	"owner" text DEFAULT 'sara' NOT NULL,
	"owner_reason" text,
	"boris_note" text,
	"closed_at" timestamp with time zone,
	"handled_through" text,
	"last_client_heard_at" timestamp with time zone,
	"typing_at" timestamp with time zone,
	"unclear_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."exam_result" (
	"run_id" uuid NOT NULL,
	"scenario_id" text NOT NULL,
	"move" text,
	"text" text,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"judge" jsonb,
	"severity" text,
	"score" real NOT NULL,
	CONSTRAINT "exam_result_run_id_scenario_id_pk" PRIMARY KEY("run_id","scenario_id")
);
--> statement-breakpoint
CREATE TABLE "core"."exam_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"mind_version" text NOT NULL,
	"roles_version" jsonb NOT NULL,
	"scenario_set" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"score" real,
	"s1" integer DEFAULT 0 NOT NULL,
	"s2" integer DEFAULT 0 NOT NULL,
	"s3" integer DEFAULT 0 NOT NULL,
	"passed" boolean,
	"compared_to" uuid
);
--> statement-breakpoint
CREATE TABLE "core"."mind_gap" (
	"id" uuid PRIMARY KEY NOT NULL,
	"turn_id" text NOT NULL,
	"text" text NOT NULL,
	"topic" text,
	"question_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."mind_index" (
	"record_id" text PRIMARY KEY NOT NULL,
	"path" text NOT NULL,
	"type" text NOT NULL,
	"scope" text NOT NULL,
	"topic" text,
	"tones" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"example_client" text,
	"example_boris" text,
	"version" integer NOT NULL,
	"mind_version" text NOT NULL,
	"tsv" "tsvector" NOT NULL,
	"embedding" vector(384)
);
--> statement-breakpoint
CREATE TABLE "core"."mind_proposal" (
	"id" uuid PRIMARY KEY NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"state" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"exported_at" timestamp with time zone,
	CONSTRAINT "mind_proposal_path_unique" UNIQUE("path")
);
--> statement-breakpoint
ALTER TABLE "core"."chat_message" ADD CONSTRAINT "chat_message_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "core"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."conv_turn" ADD CONSTRAINT "conv_turn_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "core"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."conversation" ADD CONSTRAINT "conversation_deal_id_deal_id_fk" FOREIGN KEY ("deal_id") REFERENCES "core"."deal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."exam_result" ADD CONSTRAINT "exam_result_run_id_exam_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "core"."exam_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_message_platform" ON "core"."chat_message" USING btree ("account_id","platform_message_id");--> statement-breakpoint
CREATE INDEX "chat_message_conversation" ON "core"."chat_message" USING btree ("conversation_id","sent_at");--> statement-breakpoint
CREATE INDEX "conv_turn_conversation" ON "core"."conv_turn" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_account_chat" ON "core"."conversation" USING btree ("account_id","chat_id");--> statement-breakpoint
CREATE INDEX "mind_index_tsv" ON "core"."mind_index" USING gin ("tsv");