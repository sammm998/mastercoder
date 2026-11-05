import type { ZodTypeAny, output } from "zod";
import { extractJson } from "@forge/shared";
import type { CompletionRequest, CompletionResponse, ContentBlock, LLMProvider } from "./types.js";

export function textOf(r: { content: ContentBlock[] }): string {
  return r.content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

export function toolUses(r: { content: ContentBlock[] }): Array<Extract<ContentBlock, { type: "tool_use" }>> {
  return r.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
}

export class StructuredOutputError extends Error {
  constructor(message: string, public readonly raw: string) {
    super(message);
  }
}

/**
 * Ask for JSON matching a zod schema. Retries once with the validation error fed back.
 * Returns the parsed value plus the responses (for metering).
 */
export async function structured<S extends ZodTypeAny>(
  llm: LLMProvider,
  req: CompletionRequest,
  schema: S,
  opts: { retries?: number } = {},
): Promise<{ value: output<S>; responses: CompletionResponse[] }> {
  const responses: CompletionResponse[] = [];
  const messages = [...req.messages];
  const system = `${req.system ?? ""}\n\nRespond with a single JSON value only. No prose, no markdown fences.`.trim();
  const retries = opts.retries ?? 1;
  let lastErr = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await llm.complete({ ...req, system, messages });
    responses.push(r);
    const raw = textOf(r);
    try {
      const parsed = schema.safeParse(extractJson(raw));
      if (parsed.success) return { value: parsed.data as output<S>, responses };
      lastErr = parsed.error.message;
    } catch (e) {
      lastErr = (e as Error).message;
    }
    messages.push({ role: "assistant", content: raw || "(empty)" });
    messages.push({ role: "user", content: `That output was invalid: ${lastErr.slice(0, 2000)}\nReturn corrected JSON only.` });
  }
  throw new StructuredOutputError(`Structured output failed for ${req.purpose}: ${lastErr}`, lastErr);
}
