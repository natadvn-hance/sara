CREATE TABLE "node"."node_flag" (
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"reason" text NOT NULL,
	"set_at" timestamp with time zone NOT NULL,
	CONSTRAINT "node_flag_account_id_name_pk" PRIMARY KEY("account_id","name")
);
