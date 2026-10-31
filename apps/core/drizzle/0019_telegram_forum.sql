CREATE TABLE "core"."forum_topic" (
	"chat_id" bigint NOT NULL,
	"key" text NOT NULL,
	"thread_id" integer NOT NULL,
	"conversation_id" uuid,
	"name" text NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forum_topic_chat_id_key_pk" PRIMARY KEY("chat_id","key")
);
--> statement-breakpoint
CREATE TABLE "core"."telegram_forum" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"chat_id" bigint NOT NULL,
	"title" text,
	"leads_thread_id" integer,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_forum_single_row" CHECK ("core"."telegram_forum"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "core"."telegram_post" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chat_id" bigint NOT NULL,
	"message_id" integer NOT NULL,
	"thread_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "forum_topic_thread" ON "core"."forum_topic" USING btree ("chat_id","thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_post_message" ON "core"."telegram_post" USING btree ("chat_id","message_id");