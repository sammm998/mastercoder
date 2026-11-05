import { z, type ZodType } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { JsonSchema, ToolDef } from "./types.js";

export interface ToolContext {
  /** Free-form context: sandbox, project id, event sink, approval gate... supplied by the caller. */
  [key: string]: unknown;
}

export interface ForgeTool<I = unknown> {
  name: string;
  description: string;
  input: ZodType<I>;
  /** Irreversible tools (send, pay, delete) require human approval in agents-runtime. */
  irreversible?: boolean;
  run(input: I, ctx: ToolContext): Promise<string | Record<string, unknown>>;
}

export function defineTool<S extends ZodType>(t: {
  name: string;
  description: string;
  input: S;
  irreversible?: boolean;
  run(input: z.infer<S>, ctx: ToolContext): Promise<string | Record<string, unknown>>;
}): ForgeTool<z.infer<S>> {
  return t;
}

export function toToolDef(t: ForgeTool<unknown>): ToolDef {
  const schema = zodToJsonSchema(t.input, { target: "jsonSchema7", $refStrategy: "none" }) as JsonSchema;
  delete schema.$schema;
  return { name: t.name, description: t.description, inputSchema: schema };
}

export interface ToolRunOutcome {
  ok: boolean;
  output: string;
}

/** Validate and run a tool call; never throws (errors become is_error tool results). */
export async function runTool(tools: ForgeTool<unknown>[], name: string, input: unknown, ctx: ToolContext): Promise<ToolRunOutcome> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { ok: false, output: `Unknown tool "${name}". Available: ${tools.map((t) => t.name).join(", ")}` };
  const parsed = tool.input.safeParse(input);
  if (!parsed.success) return { ok: false, output: `Invalid input for ${name}: ${parsed.error.message}` };
  try {
    const out = await tool.run(parsed.data, ctx);
    return { ok: true, output: typeof out === "string" ? out : JSON.stringify(out) };
  } catch (e) {
    return { ok: false, output: `${name} failed: ${(e as Error).message}` };
  }
}
