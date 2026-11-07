CREATE TABLE "core"."topic_discussion" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"ref" integer NOT NULL,
	"kind" text NOT NULL,
	"text" text,
	"task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_at" timestamp with time zone,
	"cleared_how" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "topic_discussion_ref" ON "core"."topic_discussion" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "topic_discussion_open" ON "core"."topic_discussion" USING btree ("conversation_id","cleared_at");