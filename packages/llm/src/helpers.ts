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
  /** `raw` is the last validation error; `lastValue` the last parsed (invalid) JSON, if any. */
  constructor(message: string, public readonly raw: string, public readonly lastValue?: unknown) {
    super(message);
  }
}

/** Readable validation errors ("story.steps: Array must contain at least 3 element(s)") for the model. */
export function formatZodIssues(issues: Array<{ path: Array<string | number>; message: string }>): string {
  return issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

/**
 * Ask for JSON matching a zod schema. Retries (default twice) with the validation errors fed back;
 * `normalize` may repair structural drift before validation.
 * Returns the parsed value plus the responses (for metering).
 */
export async function structured<S extends ZodTypeAny>(
  llm: LLMProvider,
  req: CompletionRequest,
  schema: S,
  opts: { retries?: number; normalize?: (v: unknown) => unknown } = {},
): Promise<{ value: output<S>; responses: CompletionResponse[] }> {
  const responses: CompletionResponse[] = [];
  const messages = [...req.messages];
  const system = `${req.system ?? ""}\n\nRespond with a single JSON value only. No prose, no markdown fences.`.trim();
  const retries = opts.retries ?? 2;
  let lastErr = "";
  let lastValue: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await llm.complete({ ...req, system, messages });
    responses.push(r);
    const raw = textOf(r);
    try {
      const json = extractJson(raw);
      lastValue = opts.normalize ? opts.normalize(json) : json;
      const parsed = schema.safeParse(lastValue);
      if (parsed.success) return { value: parsed.data as output<S>, responses };
      lastErr = formatZodIssues(parsed.error.issues);
    } catch (e) {
      lastErr = (e as Error).message;
    }
    messages.push({ role: "assistant", content: raw || "(empty)" });
    messages.push({ role: "user", content: `That output did not match the required shape:\n${lastErr.slice(0, 2000)}\nFix exactly these fields, keep everything else, and return the complete corrected JSON only.` });
  }
  throw new StructuredOutputError(`Structured output failed for ${req.purpose}: ${lastErr}`, lastErr, lastValue);
}
