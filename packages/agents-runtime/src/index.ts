import "./mock-llm.js";
import { selectAdapter } from "@forge/shared";
import type { LLMProvider } from "@forge/llm";
import { InHouseAgentRunner, type AgentRunner } from "./runner.js";
import { ClaudeAgentSdkRunner } from "./adapters/claude-agent-sdk.js";

export * from "./definition.js";
export * from "./ports.js";
export * from "./runner.js";
export * from "./define.js";
export * from "./service.js";
export * from "./channels.js";
export { mockDefinition, cronFromText } from "./mock-llm.js";
export { ClaudeAgentSdkRunner } from "./adapters/claude-agent-sdk.js";

/**
 * AGENT_RUNNER=claude-agent-sdk|inhouse|mock. Default: the Claude Agent SDK when LLM_PROVIDER=anthropic,
 * otherwise Forge's in-house loop over the configured LLM provider ("mock" = in-house loop + mock LLM).
 */
export function createAgentRunner(llm: LLMProvider): AgentRunner {
  const inhouse = new InHouseAgentRunner(llm);
  return selectAdapter<AgentRunner>(
    "AGENT_RUNNER",
    { "claude-agent-sdk": () => new ClaudeAgentSdkRunner(inhouse), inhouse: () => inhouse, mock: () => inhouse },
    process.env.LLM_PROVIDER === "anthropic" ? "claude-agent-sdk" : "inhouse",
  ).instance;
}
