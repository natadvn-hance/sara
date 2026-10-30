CREATE TABLE "core"."notice" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link" text,
	"task_id" uuid,
	"question_id" uuid,
	"telegram_message_id" bigint,
	"seen_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "notice_created" ON "core"."notice" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "notice_task" ON "core"."notice" USING btree ("task_id");