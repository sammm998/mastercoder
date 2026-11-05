/**
 * Offline handlers for the LLM purposes this package uses, so LLM_PROVIDER=mock runs the whole meeting
 * pipeline without keys. Output is rule-based (src/rules.ts) and labelled `generator: "mock-rules"`.
 */
import { registerMockHandler, type CompletionRequest } from "@forge/llm";
import { buildSpec, extractMeeting } from "./rules.js";
import { ExtractionSchema } from "./schemas.js";

export const PURPOSE_EXTRACT = "meetings.extract";
export const PURPOSE_SPEC = "meetings.spec";

function lastUserText(req: CompletionRequest): string {
  const m = [...req.messages].reverse().find((x) => x.role === "user");
  if (!m) return "";
  return typeof m.content === "string" ? m.content : m.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

/** The first user message carries the payload (retries append correction messages after it). */
function payload(req: CompletionRequest): string {
  const first = req.messages.find((x) => x.role === "user");
  if (!first) return lastUserText(req);
  return typeof first.content === "string" ? first.content : first.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

export function tag(text: string, name: string): string | undefined {
  const m = text.match(new RegExp(`<${name}>\\n?([\\s\\S]*?)\\n?</${name}>`));
  return m?.[1];
}

registerMockHandler(PURPOSE_EXTRACT, (req) => {
  const p = payload(req);
  const transcript = tag(p, "transcript");
  if (transcript === undefined) throw new Error("meetings.extract mock: no <transcript> in prompt");
  return JSON.stringify(extractMeeting(transcript, tag(p, "language") ?? "sv"));
});

registerMockHandler(PURPOSE_SPEC, (req) => {
  const p = payload(req);
  const transcript = tag(p, "transcript") ?? "";
  const raw = tag(p, "extraction");
  if (raw === undefined) throw new Error("meetings.spec mock: no <extraction> in prompt");
  const extraction = ExtractionSchema.parse(JSON.parse(raw));
  return JSON.stringify(buildSpec(extraction, transcript, tag(p, "language") ?? "sv"));
});
