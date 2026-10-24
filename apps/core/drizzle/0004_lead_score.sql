CREATE TABLE "core"."lead_score" (
	"id" uuid PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"version" integer NOT NULL,
	"score" integer NOT NULL,
	"decision" text NOT NULL,
	"stop_factor" text,
	"red_flags" jsonb NOT NULL,
	"axes" jsonb NOT NULL,
	"reason" text NOT NULL,
	"confidence" real NOT NULL,
	"model" text NOT NULL,
	"backtest" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "lead_score_lead" ON "core"."lead_score" USING btree ("lead_id","backtest");