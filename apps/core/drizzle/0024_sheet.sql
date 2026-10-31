CREATE TABLE "core"."sheet_row" (
	"order_id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"state" text DEFAULT 'new' NOT NULL,
	"written" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"boris" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pending_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."sheet_sync" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"since" timestamp with time zone NOT NULL,
	"last_ok_at" timestamp with time zone,
	"last_write_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	"next_try_at" timestamp with time zone,
	CONSTRAINT "sheet_sync_single_row" CHECK ("core"."sheet_sync"."id" = 1)
);
