CREATE TABLE "node"."message_attempt" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"expect_last_message_id" text,
	"pressed_at" timestamp with time zone NOT NULL,
	"result" jsonb
);
