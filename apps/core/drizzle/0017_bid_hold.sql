CREATE TABLE "core"."bid_hold" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"request_id" uuid NOT NULL,
	"state" text NOT NULL,
	"expected_fee_rub" integer NOT NULL,
	"execute_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bid_hold_request_id_unique" UNIQUE("request_id")
);
