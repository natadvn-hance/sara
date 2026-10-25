CREATE TABLE "core"."autonomy_counter" (
	"topic" text NOT NULL,
	"scope" text NOT NULL,
	"streak" integer DEFAULT 0 NOT NULL,
	"last_edit_at" timestamp with time zone,
	"last_substantial_at" timestamp with time zone,
	"last_reason" text,
	"last_turn_id" text,
	"trainer_good" integer DEFAULT 0 NOT NULL,
	"trainer_total" integer DEFAULT 0 NOT NULL,
	"proposed_at" timestamp with time zone,
	"proposal_task_id" uuid,
	"snoozed_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "autonomy_counter_topic_scope_pk" PRIMARY KEY("topic","scope")
);
--> statement-breakpoint
CREATE TABLE "core"."lesson" (
	"id" uuid PRIMARY KEY NOT NULL,
	"n" bigserial NOT NULL,
	"source" text NOT NULL,
	"source_ref" text NOT NULL,
	"scope" text DEFAULT 'shared' NOT NULL,
	"topic" text,
	"tone" text,
	"question_type" text,
	"client_text" text,
	"before" text,
	"after" text,
	"insight" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'new' NOT NULL,
	"in_place" boolean DEFAULT false NOT NULL,
	"sim" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"batch_id" uuid,
	"task_id" uuid,
	"reason" text,
	"model_call_id" uuid,
	"commit_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "lesson_n_unique" UNIQUE("n")
);
--> statement-breakpoint
CREATE TABLE "core"."lesson_batch" (
	"id" uuid PRIMARY KEY NOT NULL,
	"lesson_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"task_id" uuid,
	"telegram_message_id" bigint,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"commit_id" uuid
);
--> statement-breakpoint
CREATE TABLE "core"."mind_commit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sha" text NOT NULL,
	"kind" text NOT NULL,
	"proposal_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lesson_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mind_version_before" text,
	"reverts_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pushed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "core"."persona" (
	"id" text PRIMARY KEY NOT NULL,
	"archetype" text NOT NULL,
	"niche" text NOT NULL,
	"task" text NOT NULL,
	"mood" text NOT NULL,
	"style" text DEFAULT '' NOT NULL,
	"questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"order" jsonb NOT NULL,
	"difficulty" integer NOT NULL,
	"hard" boolean DEFAULT false NOT NULL,
	"source_refs" jsonb NOT NULL,
	"handmade" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" uuid,
	CONSTRAINT "persona_sources" CHECK (jsonb_array_length("core"."persona"."source_refs") > 0)
);
--> statement-breakpoint
CREATE TABLE "core"."sim_dialog" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid,
	"persona_id" text,
	"client_messages" jsonb NOT NULL,
	"gaps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."training_item" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid,
	"mode" text NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"persona_id" text,
	"chat_id" text,
	"source_ref" text,
	"dialog" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"client_text" text,
	"sara_text" text,
	"sara_plan" jsonb,
	"boris_text" text,
	"real_boris_text" text,
	"similarity" integer,
	"verdict" text,
	"topic" text,
	"tone" text,
	"question_type" text,
	"blind_week" date,
	"blind_flip" boolean,
	"judge" jsonb,
	"lesson_id" uuid,
	"model_call_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mind_version" text,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "core"."training_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"persona_id" text,
	"via" text DEFAULT 'miniapp' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"ended_by" text,
	"items_count" integer DEFAULT 0 NOT NULL,
	"avg_similarity" real,
	"lessons_yes" integer DEFAULT 0 NOT NULL,
	"mind_version" text
);
--> statement-breakpoint
ALTER TABLE "core"."exam_run" ADD COLUMN "kind" text DEFAULT 'deploy' NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."exam_run" ADD COLUMN "trigger" text;--> statement-breakpoint
ALTER TABLE "core"."mind_gap" ADD COLUMN "lesson_id" uuid;--> statement-breakpoint
ALTER TABLE "core"."mind_proposal" ADD COLUMN "lesson_id" uuid;--> statement-breakpoint
ALTER TABLE "core"."mind_proposal" ADD COLUMN "action" text DEFAULT 'create' NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."mind_proposal" ADD COLUMN "record_id" text;--> statement-breakpoint
ALTER TABLE "core"."mind_proposal" ADD COLUMN "section" text;--> statement-breakpoint
ALTER TABLE "core"."mind_proposal" ADD COLUMN "base_version" integer;--> statement-breakpoint
ALTER TABLE "core"."mind_proposal" ADD COLUMN "change" jsonb;--> statement-breakpoint
ALTER TABLE "core"."mind_proposal" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."mind_proposal" ADD COLUMN "commit_id" uuid;--> statement-breakpoint
ALTER TABLE "core"."mind_proposal" ADD COLUMN "reject_reason" text;--> statement-breakpoint
ALTER TABLE "core"."training_item" ADD CONSTRAINT "training_item_session_id_training_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "core"."training_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lesson_source_ref" ON "core"."lesson" USING btree ("source","source_ref");--> statement-breakpoint
CREATE INDEX "lesson_state" ON "core"."lesson" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "training_item_mode" ON "core"."training_item" USING btree ("mode","state","prepared_at");--> statement-breakpoint
CREATE INDEX "training_item_chat" ON "core"."training_item" USING btree ("chat_id");