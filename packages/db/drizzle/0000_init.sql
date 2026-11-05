CREATE TABLE "abuse_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"deployment_id" text,
	"source" text NOT NULL,
	"category" text NOT NULL,
	"evidence" jsonb,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"version" integer NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"input" jsonb,
	"log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_run_id" text,
	"task_id" text,
	"action" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"meta" jsonb,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"actor_id" text,
	"action" text NOT NULL,
	"target" text,
	"meta" jsonb,
	"ip" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checkpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text,
	"label" text NOT NULL,
	"commit_sha" text NOT NULL,
	"sandbox_snapshot_id" text,
	"db_branch_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"selector" text,
	"path" text,
	"body" text NOT NULL,
	"resolved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"app" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"external_id" text,
	"config" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"checkpoint_id" text,
	"branch" text DEFAULT 'main' NOT NULL,
	"url" text,
	"provider" text NOT NULL,
	"region" text NOT NULL,
	"status" text NOT NULL,
	"gate_report" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"hostname" text NOT NULL,
	"verification_token" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"tls_status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_embeddings" (
	"project_id" text NOT NULL,
	"path" text NOT NULL,
	"chunk" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(256) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_embeddings_project_id_path_chunk_pk" PRIMARY KEY("project_id","path","chunk")
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" text NOT NULL,
	"accepted_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "magic_links" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text,
	"source" text NOT NULL,
	"provider" text,
	"external_bot_id" text,
	"meeting_url" text,
	"title" text,
	"language" text DEFAULT 'sv' NOT NULL,
	"status" text NOT NULL,
	"consent_notice_posted" boolean DEFAULT false NOT NULL,
	"transcript" jsonb,
	"extraction" jsonb,
	"spec" jsonb,
	"audio_key" text,
	"retention_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"template" text,
	"brand" jsonb,
	"art_direction" jsonb,
	"is_public" boolean DEFAULT false NOT NULL,
	"remix_of" text,
	"github_repo" text,
	"sandbox_id" text,
	"db_branch_root" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "provider_health" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"ok" boolean NOT NULL,
	"latency_ms" integer,
	"error" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retention_policies" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"recording_days" integer DEFAULT 30 NOT NULL,
	"transcript_days" integer DEFAULT 365 NOT NULL,
	"event_days" integer DEFAULT 180 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text,
	"name" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"wrapped_dek" text NOT NULL,
	"key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"prompt" text NOT NULL,
	"source" text DEFAULT 'typed' NOT NULL,
	"intents" jsonb,
	"status" text DEFAULT 'queued' NOT NULL,
	"plan_mode" boolean DEFAULT false NOT NULL,
	"spec" jsonb,
	"estimate_low_usd" double precision,
	"estimate_high_usd" double precision,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"charged_usd" double precision DEFAULT 0 NOT NULL,
	"charged" boolean DEFAULT false NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "upload_chunks" (
	"upload_id" text NOT NULL,
	"index" integer NOT NULL,
	"storage_key" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_chunks_upload_id_index_pk" PRIMARY KEY("upload_id","index")
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"project_id" text,
	"task_id" text,
	"agent_id" text,
	"kind" text NOT NULL,
	"quantity" double precision NOT NULL,
	"cost_usd" double precision NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_agent_versions" (
	"agent_id" text NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_agent_versions_agent_id_version_pk" PRIMARY KEY("agent_id","version")
);
--> statement-breakpoint
CREATE TABLE "user_agents" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"definition" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"webhook_secret" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"password_hash" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"spend_cap_usd" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"stripe_customer_id" text,
	"spend_cap_usd" double precision,
	"region" text DEFAULT 'eu-central-1' NOT NULL,
	"sso_domain" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_id_user_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."user_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_agent_versions" ADD CONSTRAINT "user_agent_versions_agent_id_user_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."user_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_agents" ADD CONSTRAINT "user_agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_ws_idx" ON "audit_log" USING btree ("workspace_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_token_idx" ON "auth_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "checkpoints_project_idx" ON "checkpoints" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "domains_host_idx" ON "domains" USING btree ("hostname");--> statement-breakpoint
CREATE INDEX "events_project_idx" ON "events" USING btree ("project_id","at");--> statement-breakpoint
CREATE INDEX "projects_ws_idx" ON "projects" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "provider_health_idx" ON "provider_health" USING btree ("provider","checked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "secrets_scope_name_idx" ON "secrets" USING btree ("workspace_id","project_id","name");--> statement-breakpoint
CREATE INDEX "tasks_project_idx" ON "tasks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "usage_ws_idx" ON "usage_records" USING btree ("workspace_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");