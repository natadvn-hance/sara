CREATE TABLE "core"."secretary_message" (
	"id" uuid PRIMARY KEY NOT NULL,
	"author" text NOT NULL,
	"text" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"telegram_message_id" bigint
);
--> statement-breakpoint
CREATE INDEX "secretary_message_at" ON "core"."secretary_message" USING btree ("at");