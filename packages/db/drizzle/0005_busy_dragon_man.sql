CREATE TABLE "stored_objects" (
	"key" text PRIMARY KEY NOT NULL,
	"content_type" text DEFAULT 'application/octet-stream' NOT NULL,
	"size" integer NOT NULL,
	"body" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
