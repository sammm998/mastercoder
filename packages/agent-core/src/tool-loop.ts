import { runTool, toToolDef, textOf, toolUses, type ChatMessage, type ContentBlock, type ForgeTool, type LLMProvider, type ToolContext } from "@forge/llm";
import type { EventSink } from "@forge/shared";

export interface ToolLoopInput {
  llm: LLMProvider;
  model: string;
  purpose: string;
  system: string;
  messages: ChatMessage[];
  tools: ForgeTool<unknown>[];
  events: EventSink;
  projectId: string;
  taskId: string;
  maxTurns?: number;
  toolContext?: ToolContext;
  isCancelled?: () => Promise<boolean>;
}

export interface ToolLoopResult {
  finalText: string;
  turns: number;
  stopReason: string;
  toolCalls: number;
  toolErrors: string[];
  costUsd: number;
  messages: ChatMessage[];
}

/**
 * Manual agentic loop: call the model, execute every tool_use block (in parallel), return all
 * tool_result blocks in ONE user message, repeat until the model stops calling tools. Provider-native
 * reasoning blocks are preserved verbatim in the assistant turn (append-only history).
 */
export async function runToolLoop(i: ToolLoopInput): Promise<ToolLoopResult> {
  const defs = i.tools.map(toToolDef);
  const messages = [...i.messages];
  let turns = 0;
  let toolCalls = 0;
  let costUsd = 0;
  const toolErrors: string[] = [];
  const max = i.maxTurns ?? 40;
  let finalText = "";
  let stopReason = "end_turn";
  while (turns < max) {
    if (i.isCancelled && (await i.isCancelled())) {
      stopReason = "cancelled";
      break;
    }
    turns++;
    const r = await i.llm.complete({ purpose: i.purpose, model: i.model, system: i.system, messages, tools: defs, cache: true, maxTokens: 32000 });
    costUsd += r.costUsd;
    i.events.emit({ type: "usage", projectId: i.projectId, taskId: i.taskId, costUsd: r.costUsd, tokensIn: r.usage.inputTokens + r.usage.cacheReadTokens, tokensOut: r.usage.outputTokens });
    messages.push({ role: "assistant", content: r.content });
    const text = textOf(r).trim();
    if (text) {
      finalText = text;
      i.events.emit({ type: "message", projectId: i.projectId, taskId: i.taskId, role: "assistant", text });
    }
    stopReason = r.stopReason;
    if (r.stopReason === "refusal") break;
    const calls = toolUses(r);
    if (calls.length === 0) break;
    if (r.stopReason === "max_tokens") {
      // Tool input may be truncated: do not run it, ask the model to continue with smaller edits.
      messages.push({ role: "user", content: calls.map((c): ContentBlock => ({ type: "tool_result", toolUseId: c.id, content: "Output was cut off (max tokens). Re-issue this call with a smaller payload, e.g. split the file.", isError: true })) });
      continue;
    }
    const results = await Promise.all(
      calls.map(async (c) => {
        toolCalls++;
        i.events.emit({ type: "tool.call", projectId: i.projectId, taskId: i.taskId, tool: c.name, input: c.input, callId: c.id });
        const out = await runTool(i.tools, c.name, c.input, i.toolContext ?? {});
        if (!out.ok) toolErrors.push(`${c.name}: ${out.output.slice(0, 500)}`);
        i.events.emit({ type: "tool.result", projectId: i.projectId, taskId: i.taskId, callId: c.id, ok: out.ok, summary: out.output.slice(0, 300) });
        return { type: "tool_result" as const, toolUseId: c.id, content: out.output, isError: !out.ok };
      }),
    );
    messages.push({ role: "user", content: results });
  }
  if (turns >= max) stopReason = "max_turns";
  return { finalText, turns, stopReason, toolCalls, toolErrors, costUsd, messages };
}
