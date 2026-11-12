CREATE TABLE "core"."card_image" (
	"token" text PRIMARY KEY NOT NULL,
	"png" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."telegram_card" ADD COLUMN "kind" text DEFAULT 'photo' NOT NULL;