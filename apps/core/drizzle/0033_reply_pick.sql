CREATE TABLE "core"."reply_pick" (
	"id" uuid PRIMARY KEY NOT NULL,
	"turn_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"first_message_id" text NOT NULL,
	"replied_at" timestamp with time zone NOT NULL,
	"similarity" integer NOT NULL,
	"position" integer NOT NULL,
	"client_text" text NOT NULL,
	"draft_text" text NOT NULL,
	"reply_text" text NOT NULL,
	"promises" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"post_message_id" bigint,
	"decision" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reply_pick_turn_id_unique" UNIQUE("turn_id")
);
--> statement-breakpoint
ALTER TABLE "core"."reply_pick" ADD CONSTRAINT "reply_pick_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "core"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reply_pick_reply" ON "core"."reply_pick" USING btree ("conversation_id","first_message_id");