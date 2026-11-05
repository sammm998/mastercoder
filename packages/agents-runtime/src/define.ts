import { structured, getModels, type LLMProvider } from "@forge/llm";
import { AgentDefinitionSchema, validateDefinition, type AgentDefinition } from "./definition.js";

export const DEFINE_SYSTEM = `You design autonomous agents for Forge. From the user's description produce an agent definition:
- instructions: what the agent does step by step, in the user's language.
- tools: integration actions it needs ({type:"integration", app, action, irreversible}) and built-ins
  (memory_get, memory_set, send_email, http_get, current_time, knowledge_search). Mark irreversible actions.
- triggers: cron (5-field, with IANA timezone, default Europe/Stockholm), webhook, email, chat (web|slack|rest) or manual.
- approvals.requireFor: keep send/pay/delete/post unless the user explicitly says the agent may do it unattended.
- costCapUsdPerRun / costCapUsdPerMonth: sensible small caps.
- evals: 1-3 test cases with expectations.
Only include tools the task needs.`;

export async function generateDefinition(llm: LLMProvider, prompt: string): Promise<{ name: string; definition: AgentDefinition; costUsd: number }> {
  const { value, responses } = await structured(
    llm,
    { purpose: "agents.define", model: getModels().planner, system: DEFINE_SYSTEM, messages: [{ role: "user", content: prompt }], maxTokens: 8000, effort: "medium" },
    AgentDefinitionSchema,
  );
  const v = validateDefinition(value);
  if (!v.ok) throw new Error(`Generated definition is invalid: ${v.error}`);
  return { name: v.definition.name, definition: v.definition, costUsd: responses.reduce((a, r) => a + r.costUsd, 0) };
}
