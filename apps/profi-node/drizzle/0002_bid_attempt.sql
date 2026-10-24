CREATE TABLE "node"."bid_attempt" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"order_id" text NOT NULL,
	"due_rub" integer NOT NULL,
	"pressed_at" timestamp with time zone NOT NULL,
	"result" jsonb
);
