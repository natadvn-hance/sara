CREATE TABLE "core"."topic_shown" (
	"key" text NOT NULL,
	"ref" text NOT NULL,
	CONSTRAINT "topic_shown_key_ref_pk" PRIMARY KEY("key","ref")
);
