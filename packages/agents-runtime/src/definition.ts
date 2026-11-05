import { z } from "zod";
import { CronExpressionParser } from "cron-parser";

export const ToolRefSchema = z.discriminatedUnion("type", [
  /** An action on a connected app (Composio/Nango/Pipedream connection). */
  z.object({ type: z.literal("integration"), app: z.string(), action: z.string(), irreversible: z.boolean().default(false) }),
  /** An OpenAPI-imported operation. */
  z.object({ type: z.literal("openapi"), connectionId: z.string(), operationId: z.string(), irreversible: z.boolean().default(false) }),
  /** A tool exposed by an MCP server connection. */
  z.object({ type: z.literal("mcp"), connectionId: z.string(), tool: z.string(), irreversible: z.boolean().default(false) }),
  /** Forge built-ins. */
  z.object({ type: z.literal("builtin"), name: z.enum(["memory_get", "memory_set", "send_email", "http_get", "current_time", "knowledge_search"]) }),
]);
export type ToolRef = z.infer<typeof ToolRefSchema>;

export const TriggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cron"), cron: z.string(), timezone: z.string().default("Europe/Stockholm") }),
  z.object({ type: z.literal("webhook") }),
  z.object({ type: z.literal("email") }),
  z.object({ type: z.literal("chat"), channel: z.enum(["web", "slack", "rest"]), slackChannel: z.string().optional() }),
  z.object({ type: z.literal("manual") }),
]);
export type Trigger = z.infer<typeof TriggerSchema>;

export const EvalCaseSchema = z.object({
  name: z.string(),
  input: z.unknown(),
  expect: z.object({
    outputContains: z.array(z.string()).default([]),
    toolsCalled: z.array(z.string()).default([]),
    toolsNotCalled: z.array(z.string()).default([]),
    requiresApproval: z.boolean().optional(),
  }),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

export const AgentDefinitionSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().default(""),
  instructions: z.string().min(10),
  modelTier: z.enum(["fast", "builder", "planner"]).default("builder"),
  tools: z.array(ToolRefSchema).default([]),
  triggers: z.array(TriggerSchema).min(1),
  channels: z.array(z.enum(["web_widget", "slack", "email", "rest"])).default([]),
  memory: z.object({ enabled: z.boolean().default(true), maxKeys: z.number().int().min(1).max(10_000).default(200) }).default({}),
  knowledge: z.array(z.object({ title: z.string(), content: z.string() })).default([]),
  costCapUsdPerRun: z.number().positive().max(100).default(1),
  costCapUsdPerMonth: z.number().positive().max(10_000).default(25),
  approvals: z
    .object({
      /** Irreversible action kinds that need a human (send, pay, delete). */
      requireFor: z.array(z.enum(["send", "pay", "delete", "post", "update"])).default(["send", "pay", "delete", "post"]),
      /** Tool names the user explicitly allowed to run without approval for this agent. */
      autoApprove: z.array(z.string()).default([]),
    })
    .default({}),
  recipients: z.array(z.string().email()).default([]),
  evals: z.array(EvalCaseSchema).default([]),
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

export function validateDefinition(def: unknown): { ok: true; definition: AgentDefinition } | { ok: false; error: string } {
  const p = AgentDefinitionSchema.safeParse(def);
  if (!p.success) return { ok: false, error: p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  for (const t of p.data.triggers) {
    if (t.type === "cron") {
      const err = cronError(t.cron, t.timezone);
      if (err) return { ok: false, error: `Invalid cron "${t.cron}": ${err}` };
    }
  }
  return { ok: true, definition: p.data };
}

export function cronError(expr: string, tz = "UTC"): string | null {
  if (expr.trim().split(/\s+/).length !== 5) return "use 5 fields (minute hour day month weekday)";
  try {
    CronExpressionParser.parse(expr, { tz });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

export function nextRuns(expr: string, tz: string, n = 3, from = new Date()): Date[] {
  const it = CronExpressionParser.parse(expr, { tz, currentDate: from });
  return Array.from({ length: n }, () => it.next().toDate());
}

/** Tool name as exposed to the model. */
export function toolName(t: ToolRef): string {
  switch (t.type) {
    case "integration":
      return `${t.app}__${t.action}`.replace(/[^a-zA-Z0-9_-]/g, "_");
    case "openapi":
      return `api__${t.operationId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
    case "mcp":
      return `mcp__${t.tool}`.replace(/[^a-zA-Z0-9_-]/g, "_");
    case "builtin":
      return t.name;
  }
}

const ACTION_KIND: Array<[RegExp, AgentDefinition["approvals"]["requireFor"][number]]> = [
  [/(send|email|mail|reply|forward)/i, "send"],
  [/(pay|charge|refund|invoice|transfer)/i, "pay"],
  [/(delete|remove|archive|destroy)/i, "delete"],
  [/(post|publish|message|tweet)/i, "post"],
  [/(update|edit|patch|modify)/i, "update"],
];

/** Classify a tool into an irreversible action kind (or null when it is read-only). */
export function actionKind(t: ToolRef): AgentDefinition["approvals"]["requireFor"][number] | null {
  if (t.type === "builtin") return t.name === "send_email" ? "send" : null;
  const name = t.type === "integration" ? t.action : t.type === "openapi" ? t.operationId : t.tool;
  if (!t.irreversible && !/(send|pay|charge|delete|remove|post|publish)/i.test(name)) return null;
  for (const [re, kind] of ACTION_KIND) if (re.test(name)) return kind;
  return t.irreversible ? "update" : null;
}

export function needsApproval(def: AgentDefinition, t: ToolRef): boolean {
  const kind = actionKind(t);
  if (!kind) return false;
  if (def.approvals.autoApprove.includes(toolName(t))) return false;
  return def.approvals.requireFor.includes(kind);
}
