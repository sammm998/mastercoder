import type { CompletionRequest, CompletionResponse, ContentBlock, LLMProvider, StopReason } from "../types.js";
import { costFor } from "../pricing.js";

interface OAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | Array<Record<string, unknown>>;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

/** OpenAI Chat Completions adapter (raw HTTPS). Maps Claude-tier model names via OPENAI_MODEL_MAP if set. */
export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  readonly isMock = false;
  constructor(private readonly opts: { apiKey?: string; baseURL?: string } = {}) {}

  private mapModel(model: string): string {
    if (!model.startsWith("claude")) return model;
    if (model.includes("haiku")) return process.env.OPENAI_MODEL_FAST || "gpt-4.1-mini";
    return process.env.OPENAI_MODEL_DEFAULT || "gpt-4.1";
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const model = this.mapModel(req.model);
    const messages: OAIMessage[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    for (const m of req.messages) {
      if (typeof m.content === "string") {
        messages.push({ role: m.role, content: m.content });
        continue;
      }
      if (m.role === "assistant") {
        const text = m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
        const calls = m.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
        messages.push({
          role: "assistant",
          content: text || null,
          ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.input) } })) } : {}),
        });
      } else {
        const parts: Array<Record<string, unknown>> = [];
        for (const b of m.content) {
          if (b.type === "tool_result") messages.push({ role: "tool", tool_call_id: b.toolUseId, content: b.content });
          else if (b.type === "text") parts.push({ type: "text", text: b.text });
          else if (b.type === "image") parts.push({ type: "image_url", image_url: { url: `data:${b.mediaType};base64,${b.data}` } });
        }
        if (parts.length) messages.push({ role: "user", content: parts });
      }
    }
    const res = await fetch(`${this.opts.baseURL ?? "https://api.openai.com/v1"}/chat/completions`, {
      method: "POST",
      signal: req.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey ?? process.env.OPENAI_API_KEY ?? "proxy-injected"}` },
      body: JSON.stringify({
        model,
        max_completion_tokens: req.maxTokens ?? 8000,
        messages,
        ...(req.tools?.length
          ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })) }
          : {}),
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const data = (await res.json()) as {
      model: string;
      choices: Array<{ finish_reason: string; message: { content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
      usage: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number } };
    };
    const choice = data.choices[0];
    if (!choice) throw new Error("OpenAI returned no choices");
    const content: ContentBlock[] = [];
    if (choice.message.content) content.push({ type: "text", text: choice.message.content });
    for (const c of choice.message.tool_calls ?? []) {
      let input: unknown = {};
      try {
        input = JSON.parse(c.function.arguments || "{}");
      } catch {
        input = { _invalid_json: c.function.arguments };
      }
      content.push({ type: "tool_use", id: c.id, name: c.function.name, input });
    }
    const cached = data.usage.prompt_tokens_details?.cached_tokens ?? 0;
    const usage = { inputTokens: data.usage.prompt_tokens - cached, outputTokens: data.usage.completion_tokens, cacheReadTokens: cached, cacheWriteTokens: 0 };
    const stop: StopReason = choice.finish_reason === "tool_calls" ? "tool_use" : choice.finish_reason === "length" ? "max_tokens" : choice.finish_reason === "stop" ? "end_turn" : "other";
    return { content, stopReason: stop, usage, model: data.model, costUsd: costFor(model, usage), provider: this.name };
  }
}
