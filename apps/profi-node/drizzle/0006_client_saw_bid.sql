CREATE TABLE "node"."client_saw_bid" (
	"account_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "client_saw_bid_account_id_chat_id_pk" PRIMARY KEY("account_id","chat_id")
);
