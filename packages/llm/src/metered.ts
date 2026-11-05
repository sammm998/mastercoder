import type { UsageSink } from "@forge/shared";
import type { CompletionRequest, CompletionResponse, LLMProvider } from "./types.js";

export interface MeterContext {
  workspaceId?: string;
  projectId?: string;
  taskId?: string;
  agentId?: string;
}

/** Wraps a provider and records token usage + cost for every call. */
export class MeteredLLM implements LLMProvider {
  readonly name: string;
  readonly isMock: boolean;
  totalCostUsd = 0;
  totalInput = 0;
  totalOutput = 0;
  calls = 0;
  constructor(
    private readonly inner: LLMProvider,
    private readonly sink: UsageSink,
    private readonly ctx: MeterContext = {},
  ) {
    this.name = inner.name;
    this.isMock = inner.isMock;
  }
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const r = await this.inner.complete(req);
    this.calls++;
    this.totalCostUsd += r.costUsd;
    this.totalInput += r.usage.inputTokens;
    this.totalOutput += r.usage.outputTokens;
    const common = { provider: r.provider, model: r.model, ...this.ctx };
    const total = r.usage.inputTokens + r.usage.outputTokens + r.usage.cacheReadTokens + r.usage.cacheWriteTokens || 1;
    // Split cost proportionally so per-kind totals sum to the call cost.
    const parts: Array<["llm_input_tokens" | "llm_output_tokens" | "llm_cache_read_tokens" | "llm_cache_write_tokens", number]> = [
      ["llm_input_tokens", r.usage.inputTokens],
      ["llm_output_tokens", r.usage.outputTokens],
      ["llm_cache_read_tokens", r.usage.cacheReadTokens],
      ["llm_cache_write_tokens", r.usage.cacheWriteTokens],
    ];
    for (const [kind, q] of parts) {
      if (q > 0) await this.sink.record({ kind, quantity: q, costUsd: (r.costUsd * q) / total, ...common });
    }
    return r;
  }
  withContext(ctx: MeterContext): MeteredLLM {
    return new MeteredLLM(this.inner, this.sink, { ...this.ctx, ...ctx });
  }
}
