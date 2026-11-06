import { pgTable, text, timestamp, jsonb, boolean, integer, doublePrecision, primaryKey, index, uniqueIndex, vector, customType } from "drizzle-orm/pg-core";

const ts = (n: string) => timestamp(n, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  name: text("name").notNull().default(""),
  locale: text("locale").notNull().default("en"),
  passwordHash: text("password_hash"),
  emailVerified: boolean("email_verified").notNull().default(false),
  isAdmin: boolean("is_admin").notNull().default(false),
  spendCapUsd: doublePrecision("spend_cap_usd"),
  createdAt: createdAt(),
  deletedAt: ts("deleted_at"),
}, (t) => [uniqueIndex("users_email_idx").on(t.email)]);

export const authSessions = pgTable("auth_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: ts("expires_at").notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("auth_sessions_token_idx").on(t.tokenHash)]);

export const magicLinks = pgTable("magic_links", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
});

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  plan: text("plan").notNull().default("free"), // free | pro | team | enterprise
  stripeCustomerId: text("stripe_customer_id"),
  spendCapUsd: doublePrecision("spend_cap_usd"),
  region: text("region").notNull().default("eu-central-1"),
  ssoDomain: text("sso_domain"),
  createdAt: createdAt(),
});

export const memberships = pgTable("memberships", {
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // owner | admin | editor | viewer
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })]);

export const invites = pgTable("invites", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role").notNull(),
  tokenHash: text("token_hash").notNull(),
  invitedBy: text("invited_by").notNull(),
  acceptedAt: ts("accepted_at"),
  expiresAt: ts("expires_at").notNull(),
  createdAt: createdAt(),
});

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  template: text("template"),
  brand: jsonb("brand"), // design tokens
  artDirection: jsonb("art_direction"),
  isPublic: boolean("is_public").notNull().default(false),
  remixOf: text("remix_of"),
  githubRepo: text("github_repo"),
  sandboxId: text("sandbox_id"),
  dbBranchRoot: text("db_branch_root"),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
  deletedAt: ts("deleted_at"),
}, (t) => [index("projects_ws_idx").on(t.workspaceId)]);

export const tasks = pgTable("tasks", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  prompt: text("prompt").notNull(),
  source: text("source").notNull().default("typed"),
  intents: jsonb("intents"),
  status: text("status").notNull().default("queued"), // queued | awaiting_approval | running | succeeded | failed | cancelled
  planMode: boolean("plan_mode").notNull().default(false),
  spec: jsonb("spec"),
  estimateLowUsd: doublePrecision("estimate_low_usd"),
  estimateHighUsd: doublePrecision("estimate_high_usd"),
  costUsd: doublePrecision("cost_usd").notNull().default(0),
  chargedUsd: doublePrecision("charged_usd").notNull().default(0),
  charged: boolean("charged").notNull().default(false),
  failureReason: text("failure_reason"),
  createdAt: createdAt(),
  startedAt: ts("started_at"),
  completedAt: ts("completed_at"),
}, (t) => [index("tasks_project_idx").on(t.projectId)]);

export const events = pgTable("events", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  taskId: text("task_id"),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  at: ts("at").notNull().defaultNow(),
}, (t) => [index("events_project_idx").on(t.projectId, t.at)]);

export const checkpoints = pgTable("checkpoints", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  taskId: text("task_id"),
  label: text("label").notNull(),
  commitSha: text("commit_sha").notNull(),
  sandboxSnapshotId: text("sandbox_snapshot_id"),
  dbBranchId: text("db_branch_id"),
  createdAt: createdAt(),
}, (t) => [index("checkpoints_project_idx").on(t.projectId)]);

export const artifacts = pgTable("artifacts", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  taskId: text("task_id"),
  kind: text("kind").notNull(), // image | video | audio | deck | document | screenshot
  storageKey: text("storage_key").notNull(),
  mimeType: text("mime_type").notNull(),
  meta: jsonb("meta"),
  costUsd: doublePrecision("cost_usd").notNull().default(0),
  createdAt: createdAt(),
});

export const usageRecords = pgTable("usage_records", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id"),
  projectId: text("project_id"),
  taskId: text("task_id"),
  agentId: text("agent_id"),
  kind: text("kind").notNull(),
  quantity: doublePrecision("quantity").notNull(),
  costUsd: doublePrecision("cost_usd").notNull(),
  provider: text("provider").notNull(),
  model: text("model"),
  at: ts("at").notNull().defaultNow(),
}, (t) => [index("usage_ws_idx").on(t.workspaceId, t.at)]);

export const userAgents = pgTable("user_agents", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: text("project_id"),
  name: text("name").notNull(),
  version: integer("version").notNull().default(1),
  definition: jsonb("definition").notNull(),
  status: text("status").notNull().default("active"), // active | paused
  webhookSecret: text("webhook_secret"),
  createdAt: createdAt(),
});

export const userAgentVersions = pgTable("user_agent_versions", {
  agentId: text("agent_id").notNull().references(() => userAgents.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  definition: jsonb("definition").notNull(),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.agentId, t.version] })]);

export const agentRuns = pgTable("agent_runs", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => userAgents.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  trigger: text("trigger").notNull(),
  status: text("status").notNull(), // running | awaiting_approval | succeeded | failed
  input: jsonb("input"),
  log: jsonb("log").notNull().default([]),
  /** Resumable runner state (conversation + pending irreversible call) while awaiting approval. */
  state: jsonb("state"),
  output: text("output"),
  costUsd: doublePrecision("cost_usd").notNull().default(0),
  startedAt: ts("started_at").notNull().defaultNow(),
  endedAt: ts("ended_at"),
});

export const approvals = pgTable("approvals", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  agentRunId: text("agent_run_id"),
  taskId: text("task_id"),
  action: text("action").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull().default("pending"), // pending | approved | rejected
  decidedBy: text("decided_by"),
  decidedAt: ts("decided_at"),
  createdAt: createdAt(),
});

export const meetings = pgTable("meetings", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: text("project_id"),
  source: text("source").notNull(), // bot | recording | upload
  provider: text("provider"),
  externalBotId: text("external_bot_id"),
  meetingUrl: text("meeting_url"),
  title: text("title"),
  language: text("language").notNull().default("sv"),
  status: text("status").notNull(), // scheduled | joining | recording | processing | ready | failed | deleted
  consentNoticePosted: boolean("consent_notice_posted").notNull().default(false),
  transcript: jsonb("transcript"),
  extraction: jsonb("extraction"),
  spec: jsonb("spec"),
  audioKey: text("audio_key"),
  retentionUntil: ts("retention_until"),
  createdAt: createdAt(),
});

export const uploadChunks = pgTable("upload_chunks", {
  uploadId: text("upload_id").notNull(),
  index: integer("index").notNull(),
  storageKey: text("storage_key").notNull(),
  size: integer("size").notNull(),
  sha256: text("sha256").notNull(),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.uploadId, t.index] })]);

export const connections = pgTable("connections", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  /** Set for a connection made inside one project; null = available to the whole workspace. */
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  provider: text("provider").notNull(), // composio | nango | pipedream | openapi | mcp
  app: text("app").notNull(),
  scopes: jsonb("scopes").notNull().default([]),
  externalId: text("external_id"),
  config: jsonb("config"),
  status: text("status").notNull().default("active"), // pending | active | revoked
  createdAt: createdAt(),
  revokedAt: ts("revoked_at"),
});

export const secrets = pgTable("secrets", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id"),
  name: text("name").notNull(),
  ciphertext: text("ciphertext").notNull(),
  iv: text("iv").notNull(),
  tag: text("tag").notNull(),
  wrappedDek: text("wrapped_dek").notNull(),
  keyId: text("key_id").notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("secrets_scope_name_idx").on(t.workspaceId, t.projectId, t.name)]);

export const deployments = pgTable("deployments", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  checkpointId: text("checkpoint_id"),
  branch: text("branch").notNull().default("main"),
  url: text("url"),
  provider: text("provider").notNull(),
  region: text("region").notNull(),
  status: text("status").notNull(), // pending | blocked | live | rolled_back | failed | taken_down
  gateReport: jsonb("gate_report"),
  createdAt: createdAt(),
});

export const domains = pgTable("domains", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  hostname: text("hostname").notNull(),
  verificationToken: text("verification_token").notNull(),
  verified: boolean("verified").notNull().default(false),
  tlsStatus: text("tls_status").notNull().default("pending"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("domains_host_idx").on(t.hostname)]);

export const comments = pgTable("comments", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  selector: text("selector"),
  path: text("path"),
  body: text("body").notNull(),
  resolved: boolean("resolved").notNull().default(false),
  createdAt: createdAt(),
});

export const auditLog = pgTable("audit_log", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id"),
  actorId: text("actor_id"),
  action: text("action").notNull(),
  target: text("target"),
  meta: jsonb("meta"),
  ip: text("ip"),
  at: ts("at").notNull().defaultNow(),
}, (t) => [index("audit_ws_idx").on(t.workspaceId, t.at)]);

export const abuseReports = pgTable("abuse_reports", {
  id: text("id").primaryKey(),
  projectId: text("project_id"),
  deploymentId: text("deployment_id"),
  source: text("source").notNull(), // scan | user | moderation
  category: text("category").notNull(), // phishing | impersonation | credential_harvesting | malware | other
  evidence: jsonb("evidence"),
  status: text("status").notNull().default("open"), // open | dismissed | taken_down
  createdAt: createdAt(),
  resolvedAt: ts("resolved_at"),
});

export const fileEmbeddings = pgTable("file_embeddings", {
  projectId: text("project_id").notNull(),
  path: text("path").notNull(),
  chunk: integer("chunk").notNull(),
  content: text("content").notNull(),
  embedding: vector("embedding", { dimensions: 256 }).notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.projectId, t.path, t.chunk] })]);

export const providerHealth = pgTable("provider_health", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  kind: text("kind").notNull(),
  ok: boolean("ok").notNull(),
  latencyMs: integer("latency_ms"),
  error: text("error"),
  checkedAt: ts("checked_at").notNull().defaultNow(),
}, (t) => [index("provider_health_idx").on(t.provider, t.checkedAt)]);

export const retentionPolicies = pgTable("retention_policies", {
  workspaceId: text("workspace_id").primaryKey(),
  recordingDays: integer("recording_days").notNull().default(30),
  transcriptDays: integer("transcript_days").notNull().default(365),
  eventDays: integer("event_days").notNull().default(180),
});

/** Persisted Yjs document state for realtime collaboration (one doc per project file/room). */
export const collabDocs = pgTable("collab_docs", {
  room: text("room").primaryKey(), // `${projectId}:${path}`
  projectId: text("project_id").notNull(),
  state: text("state").notNull(), // base64 Yjs update
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Project files mirror (the sandbox is the source of truth during builds; this is the durable copy). */
export const projectFiles = pgTable("project_files", {
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  content: text("content").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.projectId, t.path] })]);

/** Long-term memory for user agents (key/value per agent). */
export const agentMemory = pgTable("agent_memory", {
  agentId: text("agent_id").notNull().references(() => userAgents.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  value: jsonb("value").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.agentId, t.key] })]);

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (v) => Buffer.from(v),
  fromDriver: (v) => new Uint8Array(v),
});

/** Object storage in Postgres (STORAGE_PROVIDER=db): media/artifacts shared by api and worker without S3. */
export const storedObjects = pgTable("stored_objects", {
  key: text("key").primaryKey(),
  contentType: text("content_type").notNull().default("application/octet-stream"),
  size: integer("size").notNull(),
  body: bytea("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
