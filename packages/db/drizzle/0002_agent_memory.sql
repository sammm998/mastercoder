CREATE TABLE "agent_memory" (
	"agent_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_memory_agent_id_key_pk" PRIMARY KEY("agent_id","key")
);
--> statement-breakpoint
ALTER TABLE "agent_memory" ADD CONSTRAINT "agent_memory_agent_id_user_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."user_agents"("id") ON DELETE cascade ON UPDATE no action;