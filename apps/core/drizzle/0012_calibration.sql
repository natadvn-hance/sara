CREATE TABLE "core"."calibration_item" (
	"run_id" uuid NOT NULL,
	"lead_id" text NOT NULL,
	"position" integer NOT NULL,
	"mark" text,
	"note" text,
	"marked_at" timestamp with time zone,
	CONSTRAINT "calibration_item_run_id_lead_id_pk" PRIMARY KEY("run_id","lead_id")
);
--> statement-breakpoint
ALTER TABLE "core"."direction_run" ADD COLUMN "advice" jsonb;