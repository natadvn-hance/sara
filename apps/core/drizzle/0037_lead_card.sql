CREATE TABLE "core"."telegram_card" (
	"ref" bigint PRIMARY KEY NOT NULL,
	"task_id" uuid,
	"card" jsonb NOT NULL,
	"state" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
