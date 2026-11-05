import { registerMockHandler, type CompletionRequest, type ContentBlock } from "@forge/llm";
import type { AgentDefinition, ToolRef } from "./definition.js";

/**
 * Rule-based stand-ins (LLM_PROVIDER=mock) for agent definition and agent runs. Deterministic
 * heuristics, not a language model.
 */

const DAYS: Record<string, number> = { sunday: 0, söndag: 0, monday: 1, måndag: 1, tuesday: 2, tisdag: 2, wednesday: 3, onsdag: 3, thursday: 4, torsdag: 4, friday: 5, fredag: 5, saturday: 6, lördag: 6 };

export function cronFromText(text: string): string | null {
  const t = text.toLowerCase();
  const time = t.match(/(?:at|kl\.?|klockan)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?/);
  let hour = time ? Number(time[1]) : 8;
  const minute = time?.[2] ? Number(time[2]) : 0;
  if (time?.[3] === "pm" && hour < 12) hour += 12;
  const day = Object.keys(DAYS).find((d) => new RegExp(`(every|varje|each)\\s+${d}`).test(t) || new RegExp(`${d}s?\\b`).test(t) && /(every|varje|each|weekly|veckovis)/.test(t));
  if (day) return `${minute} ${hour} * * ${DAYS[day]}`;
  if (/(every|varje) (weekday|vardag)/.test(t)) return `${minute} ${hour} * * 1-5`;
  if (/(every|varje) (hour|timme)/.test(t)) return `0 * * * *`;
  if (/(every|varje) (day|dag|morning|morgon)|daily|dagligen/.test(t)) return `${minute} ${hour} * * *`;
  if (/(every|varje) (month|månad)|monthly/.test(t)) return `${minute} ${hour} 1 * *`;
  return null;
}

export function mockDefinition(prompt: string): AgentDefinition {
  const p = prompt.toLowerCase();
  const tools: ToolRef[] = [];
  const cron = cronFromText(prompt);
  const triggers: AgentDefinition["triggers"] = [];
  const autoApprove: string[] = [];
  const channels: AgentDefinition["channels"] = [];
  if (/hubspot/.test(p)) tools.push({ type: "integration", app: "hubspot", action: /lead/.test(p) ? "list_recent_leads" : "list_contacts", irreversible: false });
  if (/(e-?mail|mejl|mail)/.test(p)) tools.push({ type: "builtin", name: "send_email" });
  if (/slack/.test(p)) {
    tools.push({ type: "integration", app: "slack", action: "post_message", irreversible: true });
    triggers.push({ type: "chat", channel: "slack", slackChannel: p.match(/#([\w-]+)/)?.[1] });
    channels.push("slack");
    // A chat bot whose whole job is replying in a channel: replies are its expected output.
    if (/(answer|svara|reply|respond)/.test(p)) autoApprove.push("slack__post_message");
  }
  if (/(handbook|handbok|docs|documentation|policy|faq)/.test(p)) tools.push({ type: "builtin", name: "knowledge_search" });
  if (/(website|url|http|page)/.test(p)) tools.push({ type: "builtin", name: "http_get" });
  if (cron) triggers.push({ type: "cron", cron, timezone: "Europe/Stockholm" });
  if (/webhook/.test(p)) triggers.push({ type: "webhook" });
  if (!triggers.length) triggers.push({ type: "manual" });
  tools.push({ type: "builtin", name: "current_time" });
  const name = /slack/.test(p) ? "Slack helper" : /hubspot/.test(p) && /lead/.test(p) ? "Weekly lead summary" : (prompt.split(/[.,\n]/)[0] ?? "Agent").slice(0, 60);
  return {
    name,
    description: prompt.slice(0, 280),
    instructions: `${prompt.trim()}\n\nSteps: gather the data with the read-only tools, write a concise summary, then perform the requested action. Keep track of what was already processed in memory (key "last_run").`,
    modelTier: "builder",
    tools,
    triggers,
    channels,
    memory: { enabled: true, maxKeys: 200 },
    knowledge: [],
    costCapUsdPerRun: 0.5,
    costCapUsdPerMonth: 20,
    approvals: { requireFor: ["send", "pay", "delete", "post"], autoApprove },
    recipients: [],
    evals: [
      {
        name: "does the task",
        input: { note: "eval run" },
        expect: { outputContains: [], toolsCalled: tools.filter((t) => t.type === "integration" && !t.irreversible).map((t) => (t.type === "integration" ? `${t.app}__${t.action}` : "")), toolsNotCalled: [], requiresApproval: tools.some((t) => t.type === "builtin" && t.name === "send_email") || undefined },
      },
    ],
  };
}

registerMockHandler("agents.define", (req) => {
  const m = req.messages[req.messages.length - 1];
  const text = typeof m?.content === "string" ? m.content : "";
  return JSON.stringify(mockDefinition(text));
});

function toolNames(req: CompletionRequest): string[] {
  return (req.tools ?? []).map((t) => t.name);
}

function toolResults(req: CompletionRequest): Array<{ id: string; content: string }> {
  const out: Array<{ id: string; content: string }> = [];
  for (const m of req.messages) if (Array.isArray(m.content)) for (const b of m.content) if (b.type === "tool_result") out.push({ id: b.toolUseId, content: b.content });
  return out;
}

function calledTools(req: CompletionRequest): string[] {
  const out: string[] = [];
  for (const m of req.messages) if (m.role === "assistant" && Array.isArray(m.content)) for (const b of m.content) if (b.type === "tool_use") out.push(b.name);
  return out;
}

/**
 * Mock agent policy: 1) call read-only data tools (and knowledge search with the question),
 * 2) call the action tool (email / slack post) with a summary of what was read, 3) report.
 */
registerMockHandler("agents.run", (req) => {
  const names = toolNames(req);
  const called = calledTools(req);
  const results = toolResults(req);
  const first = req.messages[0];
  const inputText = typeof first?.content === "string" ? first.content : "";
  const question = inputText.match(/"(?:text|message|question)":\s*"([^"]+)"/)?.[1] ?? "";
  const reads = names.filter((n) => /__(list|get|search|find|read)/.test(n) || n === "knowledge_search");
  const pendingReads = reads.filter((n) => !called.includes(n));
  if (pendingReads.length) {
    return pendingReads.map((n, i): ContentBlock => ({ type: "tool_use", id: `read_${called.length + i}`, name: n, input: n === "knowledge_search" ? { query: question || "overview" } : { sinceDays: 7 } }));
  }
  const rejected = results.some((r) => /REJECTED/.test(r.content));
  const action = names.find((n) => n === "send_email" || /__(post_message|send)/.test(n));
  const summary = results
    .map((r) => r.content)
    .join("\n")
    .slice(0, 1500);
  if (action && !called.includes(action) && !rejected) {
    const recipients = (req.system ?? "").match(/Default recipients: (.+)/)?.[1]?.split(/,\s*/) ?? [];
    if (action === "send_email" && recipients.length === 0) return "No recipients are configured for this agent, so nothing was sent. Summary:\n" + summary;
    const body = question ? `Answer based on the handbook:\n${summary}` : `Weekly summary\n\n${summary}`;
    return [{ type: "tool_use", id: `act_${called.length}`, name: action, input: action === "send_email" ? { to: recipients, subject: "Weekly summary", text: body } : { channel: inputText.match(/"channel":\s*"([^"]+)"/)?.[1] ?? "general", text: body } }];
  }
  if (rejected) return "The action was rejected, so nothing was sent. Here is what I prepared:\n" + summary;
  if (!names.length) return "Done.";
  return `Report: ${called.length ? `used ${[...new Set(called)].join(", ")}` : "no tools needed"}.\n${summary.slice(0, 800)}`;
});
