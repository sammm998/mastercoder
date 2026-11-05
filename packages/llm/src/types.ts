export type JsonSchema = Record<string, unknown>;

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; data: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean }
  /** Provider-native reasoning block. Must be passed back unchanged in tool loops. */
  | { type: "opaque"; provider: string; raw: unknown };

export interface ChatMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface CompletionRequest {
  /** Stable tag describing why this call is made, e.g. "intent.classify". Used for metering, tracing and mock routing. */
  purpose: string;
  model: string;
  system?: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  maxTokens?: number;
  /** Put a prompt-cache breakpoint after system + tools (stable prefix). */
  cache?: boolean;
  effort?: Effort;
  /** Optional abort signal. */
  signal?: AbortSignal;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface CompletionResponse {
  content: ContentBlock[];
  stopReason: StopReason;
  usage: TokenUsage;
  model: string;
  costUsd: number;
  provider: string;
}

export interface LLMProvider {
  readonly name: string;
  readonly isMock: boolean;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}
