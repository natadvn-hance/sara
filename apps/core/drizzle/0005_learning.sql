CREATE TABLE "core"."job_run" (
	"name" text NOT NULL,
	"day" date NOT NULL,
	CONSTRAINT "job_run_name_day_pk" PRIMARY KEY("name","day")
);
--> statement-breakpoint
CREATE TABLE "core"."lead_label" (
	"lead_id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"source" text NOT NULL,
	"reason" text,
	"voice" boolean DEFAULT false NOT NULL,
	"score" integer,
	"score_version" integer,
	"surprise" boolean DEFAULT false NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."question" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"entity_id" text NOT NULL,
	"telegram_message_id" bigint,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	"answer" text
);
--> statement-breakpoint
CREATE TABLE "core"."rule_proposal" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"from_version" integer NOT NULL,
	"rules" jsonb NOT NULL,
	"summary" text NOT NULL,
	"why" text NOT NULL,
	"backtest" jsonb NOT NULL,
	"state" text NOT NULL,
	"task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "question_open" ON "core"."question" USING btree ("answered_at","asked_at");