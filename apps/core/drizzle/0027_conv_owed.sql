CREATE TABLE "core"."conv_owed" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"anchor_message_id" text NOT NULL,
	"steps" integer DEFAULT 0 NOT NULL,
	"last_at" timestamp with time zone,
	"message_id" bigint
);
--> statement-breakpoint
ALTER TABLE "core"."conv_owed" ADD CONSTRAINT "conv_owed_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "core"."conversation"("id") ON DELETE no action ON UPDATE no action;