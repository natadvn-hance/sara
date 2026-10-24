CREATE TABLE "core"."direction_version" (
	"account_id" text NOT NULL,
	"version" integer NOT NULL,
	"rules" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"reason" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	CONSTRAINT "direction_version_account_id_version_pk" PRIMARY KEY("account_id","version")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "direction_version_one_active" ON "core"."direction_version" USING btree ("account_id") WHERE "core"."direction_version"."active";