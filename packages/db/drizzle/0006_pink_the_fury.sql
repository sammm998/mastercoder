CREATE TABLE "knowledge_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"url" text,
	"title" text DEFAULT '' NOT NULL,
	"content" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_profiles" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"profile" text NOT NULL,
	"generated_by" text DEFAULT 'llm' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"pages" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_profiles" ADD CONSTRAINT "knowledge_profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_chunks_ws_idx" ON "knowledge_chunks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_chunks_fts_idx" ON "knowledge_chunks" USING gin (to_tsvector('simple', "title" || ' ' || "content"));
