import type { CompletionRequest, CompletionResponse, ContentBlock, LLMProvider } from "./types.js";
import { costFor, estimateTokens } from "./pricing.js";

export type MockReply = string | ContentBlock[] | { content: ContentBlock[]; stopReason?: CompletionResponse["stopReason"] };
export type MockHandler = (req: CompletionRequest) => MockReply | Promise<MockReply>;

interface Registration {
  match: string | RegExp;
  handler: MockHandler;
}

const registry: Registration[] = [];

/**
 * Register a deterministic offline handler for a call `purpose`. Packages ship their own handlers
 * (in a file named `mock-llm.ts`) so the whole platform runs without API keys when LLM_PROVIDER=mock.
 * Mock output is rule-based, never a real model; it is labeled as such in events and reports.
 */
export function registerMockHandler(match: string | RegExp, handler: MockHandler): void {
  registry.unshift({ match, handler });
}

export class MockLLMProvider implements LLMProvider {
  readonly name = "mock";
  readonly isMock = true;
  readonly calls: CompletionRequest[] = [];
  constructor(private readonly local: Registration[] = []) {}

  /** Handlers local to this instance take priority over the global registry (useful in tests). */
  on(match: string | RegExp, handler: MockHandler): this {
    this.local.unshift({ match, handler });
    return this;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.calls.push(req);
    const reg = [...this.local, ...registry].find((r) =>
      typeof r.match === "string" ? r.match === req.purpose : r.match.test(req.purpose),
    );
    if (!reg) throw new Error(`MockLLMProvider: no handler registered for purpose "${req.purpose}"`);
    const reply = await reg.handler(req);
    const content: ContentBlock[] =
      typeof reply === "string" ? [{ type: "text", text: reply }] : Array.isArray(reply) ? reply : reply.content;
    const stopReason =
      !Array.isArray(reply) && typeof reply !== "string" && reply.stopReason
        ? reply.stopReason
        : content.some((b) => b.type === "tool_use")
          ? "tool_use"
          : "end_turn";
    const inText = (req.system ?? "") + JSON.stringify(req.messages) + JSON.stringify(req.tools ?? []);
    const usage = { inputTokens: estimateTokens(inText), outputTokens: estimateTokens(JSON.stringify(content)), cacheReadTokens: 0, cacheWriteTokens: 0 };
    return { content, stopReason, usage, model: req.model, costUsd: costFor(req.model, usage), provider: this.name };
  }
}
