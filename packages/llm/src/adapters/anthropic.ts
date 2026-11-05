import Anthropic from "@anthropic-ai/sdk";
import type { CompletionRequest, CompletionResponse, ContentBlock, LLMProvider, StopReason } from "../types.js";
import { costFor } from "../pricing.js";

/** Models that accept the server-side refusal fallback ("default" routing). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5", "claude-fable-5-1"]);

function toAnthropicContent(content: string | ContentBlock[]): Anthropic.ContentBlockParam[] | string {
  if (typeof content === "string") return content;
  return content.map((b): Anthropic.ContentBlockParam => {
    switch (b.type) {
      case "text":
        return { type: "text", text: b.text };
      case "image":
        return { type: "image", source: { type: "base64", media_type: b.mediaType, data: b.data } };
      case "tool_use":
        return { type: "tool_use", id: b.id, name: b.name, input: b.input };
      case "tool_result":
        return { type: "tool_result", tool_use_id: b.toolUseId, content: b.content, is_error: b.isError };
      case "opaque":
        // thinking / redacted_thinking / fallback blocks are passed back verbatim
        return b.raw as Anthropic.ContentBlockParam;
    }
  });
}

/**
 * Incremental prompt caching for multi-turn tool loops: a cache breakpoint on the last cacheable block of
 * the last message means the next turn reads the whole earlier conversation from cache (~10x cheaper)
 * instead of paying full input price for it on every tool call.
 */
export function withHistoryCache(messages: Array<{ role: "user" | "assistant"; content: Anthropic.ContentBlockParam[] | string }>) {
  const last = messages[messages.length - 1];
  if (!last) return messages;
  const blocks: Anthropic.ContentBlockParam[] = typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...last.content];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.type === "text" || b.type === "tool_result" || b.type === "tool_use" || b.type === "image") {
      blocks[i] = { ...b, cache_control: { type: "ephemeral" } } as Anthropic.ContentBlockParam;
      return [...messages.slice(0, -1), { ...last, content: blocks }];
    }
  }
  return messages;
}

function fromAnthropicBlocks(blocks: Anthropic.ContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const b of blocks) {
    if (b.type === "text") out.push({ type: "text", text: b.text });
    else if (b.type === "tool_use") out.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
    else out.push({ type: "opaque", provider: "anthropic", raw: b });
  }
  return out;
}

function mapStop(s: string | null): StopReason {
  if (s === "end_turn" || s === "tool_use" || s === "max_tokens" || s === "refusal") return s;
  return "other";
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly isMock = false;
  private client: Anthropic;
  constructor(opts: { apiKey?: string; baseURL?: string } = {}) {
    // Resolves ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / profile from env when apiKey is undefined.
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL });
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const system: Anthropic.TextBlockParam[] | undefined = req.system
      ? [{ type: "text", text: req.system, ...(req.cache ? { cache_control: { type: "ephemeral" as const } } : {}) }]
      : undefined;
    const tools: Anthropic.Tool[] | undefined = req.tools?.map((t, i, arr) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      ...(req.cache && i === arr.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
    }));
    const useFallback = process.env.LLM_FALLBACKS !== "off" && FALLBACK_MODELS.has(req.model);
    const body = {
      model: req.model,
      max_tokens: req.maxTokens ?? 16000,
      system,
      tools,
      tool_choice: tools?.length ? { type: "auto" as const } : undefined,
      messages: req.cache ? withHistoryCache(req.messages.map((m) => ({ role: m.role, content: toAnthropicContent(m.content) }))) : req.messages.map((m) => ({ role: m.role, content: toAnthropicContent(m.content) })),
      thinking: { type: "adaptive" as const },
      output_config: { effort: req.effort ?? "medium" },
      ...(useFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
    };
    // Streaming avoids HTTP timeouts on long generations; finalMessage() assembles the result.
    const stream = useFallback
      ? this.client.beta.messages.stream(body as unknown as Parameters<typeof this.client.beta.messages.stream>[0], { signal: req.signal })
      : this.client.messages.stream(body as unknown as Anthropic.MessageStreamParams, { signal: req.signal });
    const msg = (await stream.finalMessage()) as unknown as Anthropic.Message;
    const usage = {
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
      cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
    };
    return {
      content: fromAnthropicBlocks(msg.content),
      stopReason: mapStop(msg.stop_reason),
      usage,
      model: msg.model,
      costUsd: costFor(msg.model, usage),
      provider: this.name,
    };
  }
}
