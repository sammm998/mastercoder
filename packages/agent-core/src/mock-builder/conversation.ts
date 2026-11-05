import type { ChatMessage, ContentBlock } from "@forge/llm";
import { SpecSchema, type Spec } from "../spec.js";

/**
 * Reads the build agent's conversation (prompts from prompts.ts / agent.ts plus prior tool calls and
 * results) so the rule-based builder can act as a state machine without hidden state.
 */

export type RoundKind = "build" | "followup" | "fix" | "strategy" | "replan" | "design" | "review" | "unknown";

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

export interface Round {
  kind: RoundKind;
  /** The round's prompt without the appended repository map. */
  text: string;
  repoMap: string;
  /** Tool calls made in this round, in order, with their results. */
  calls: Array<ToolCall & { result?: ToolOutcome }>;
  /** Assistant turns already taken in this round. */
  turns: number;
}

export interface Conversation {
  round: Round;
  /** Tool calls of earlier rounds (for "already tried" checks). */
  earlierCalls: ToolCall[];
  spec?: Spec;
  templateId?: string;
  commands: Partial<Record<"install" | "dev" | "test" | "typecheck" | "lint" | "e2e", string>>;
}

const textOfContent = (c: ChatMessage["content"]): string => (typeof c === "string" ? c : c.map((b) => (b.type === "text" ? b.text : "")).join("\n"));
const isPrompt = (m: ChatMessage): boolean => m.role === "user" && (typeof m.content === "string" || !m.content.some((b) => b.type === "tool_result"));

function classify(text: string): RoundKind {
  if (text.includes("## Spec\n") && text.includes("## Project")) return text.includes("## Follow-up request") ? "followup" : "build";
  if (text.startsWith("The quality gates failed")) return "fix";
  if (text.startsWith("The same error keeps happening")) return "strategy";
  if (text.startsWith("The plan was revised")) return "replan";
  if (text.startsWith("The design critic scored")) return "design";
  if (text.startsWith("A reviewer with fresh context")) return "review";
  return "unknown";
}

function parseSpec(json: string): Spec | undefined {
  try {
    const r = SpecSchema.safeParse(JSON.parse(json));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

export function specFrom(text: string): Spec | undefined {
  const m = /## (?:New spec|Spec)\n([\s\S]*?)\n\n(?:## |Previous error:|$)/.exec(text) ?? /## (?:New spec|Spec)\n([\s\S]*)$/.exec(text);
  return m?.[1] ? parseSpec(m[1].trim()) : undefined;
}

export function parseConversation(messages: ChatMessage[]): Conversation {
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isPrompt(messages[i]!)) {
      start = i;
      break;
    }
  }
  const raw = start >= 0 ? textOfContent(messages[start]!.content) : "";
  const mapAt = raw.indexOf("\n\n## Repository map\n");
  const text = mapAt >= 0 ? raw.slice(0, mapAt) : raw;
  const repoMap = mapAt >= 0 ? raw.slice(mapAt + "\n\n## Repository map\n".length) : "";

  const results = new Map<string, ToolOutcome>();
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) if (b.type === "tool_result") results.set(b.toolUseId, { content: b.content, isError: Boolean(b.isError) });
  }
  const callsOf = (blocks: ContentBlock[]): ToolCall[] =>
    blocks.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, name: b.name, input: (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown> }] : []));

  const calls: Round["calls"] = [];
  const earlierCalls: ToolCall[] = [];
  let turns = 0;
  messages.forEach((m, i) => {
    if (m.role !== "assistant" || typeof m.content === "string") return;
    const cs = callsOf(m.content);
    if (i > start) {
      turns++;
      calls.push(...cs.map((c) => ({ ...c, result: results.get(c.id) })));
    } else earlierCalls.push(...cs);
  });

  // Latest spec (replans override the original) and the build prompt's template/commands.
  let spec: Spec | undefined;
  let templateId: string | undefined;
  const commands: Conversation["commands"] = {};
  for (const m of messages) {
    if (!isPrompt(m)) continue;
    const t = textOfContent(m.content);
    const s = t.includes("## Spec\n") || t.includes("## New spec\n") ? specFrom(t.split("\n\n## Repository map\n")[0] ?? t) : undefined;
    if (s) spec = s;
    const tm = /\nTemplate: ([\w-]+)/.exec(t);
    if (tm?.[1]) templateId = tm[1];
    const cm = /Commands: (.+)/.exec(t);
    if (cm?.[1]) {
      for (const k of ["install", "dev", "test", "typecheck", "lint", "e2e"] as const) {
        const v = new RegExp(`${k}=\`([^\`]*)\``).exec(cm[1])?.[1];
        if (v && v !== "-") commands[k] = v;
      }
    }
  }
  return { round: { kind: classify(text), text, repoMap, calls, turns }, earlierCalls, spec, templateId, commands };
}

/** Exit code from a run_command / run_tests result ("$ cmd\nexit N ..."), or null. */
export function exitCodeOf(r: ToolOutcome | undefined): number | null {
  if (!r) return null;
  if (r.isError) return 1;
  const m = /^exit (\d+)/m.exec(r.content);
  return m ? Number(m[1]) : null;
}

/** File content from a read_file result (strips the line-number gutter). */
export function fileFromReadResult(r: ToolOutcome | undefined): string | null {
  if (!r || r.isError) return null;
  return r.content
    .split("\n")
    .map((l) => l.replace(/^\s*\d+ {2}/, ""))
    .join("\n");
}
