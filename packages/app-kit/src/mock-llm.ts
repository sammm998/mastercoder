/**
 * Rule-based mock LLM handlers for app-kit purposes, so LLM_PROVIDER=mock runs end-to-end.
 * Output is deterministic and labeled "[mock]"; it is never presented as model output.
 */
import { registerMockHandler, type CompletionRequest } from "@forge/llm";
import { extractJson } from "@forge/shared";

interface FixContext {
  error: { type: string; message: string };
  sources: Array<{ path: string; line: number; code: string }>;
}

function userText(req: CompletionRequest): string {
  const m = req.messages.find((x) => x.role === "user");
  if (!m) return "";
  return typeof m.content === "string" ? m.content : m.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

/** Rule-based fix suggestions for the most common runtime errors. */
export function mockSuggestFix(ctx: FixContext): { summary: string; rootCause: string; patches: Array<{ path: string; search: string; replace: string }>; confidence: number } {
  const msg = ctx.error.message;
  const prop =
    /Cannot read propert(?:y|ies) of (?:undefined|null) \(reading '([^']+)'\)/.exec(msg)?.[1] ??
    /Cannot read property '([^']+)' of (?:undefined|null)/.exec(msg)?.[1] ??
    /undefined is not an object \(evaluating '[^']*\.([A-Za-z_$][\w$]*)'\)/.exec(msg)?.[1] ??
    /'NoneType' object has no attribute '([^']+)'/.exec(msg)?.[1];
  if (prop) {
    for (const s of ctx.sources) {
      const re = new RegExp(`([\\w$\\])])\\.${prop.replace(/\$/g, "\\$")}\\b`);
      if (!re.test(s.code)) continue;
      const isPy = s.path.endsWith(".py");
      const replaced = isPy ? null : s.code.replace(re, `$1?.${prop}`);
      if (replaced && replaced !== s.code) {
        return {
          summary: `[mock] Guard the access to .${prop} with optional chaining in ${s.path}:${s.line}`,
          rootCause: `[mock rule: null-property-access] The value whose "${prop}" is read is undefined or null at ${s.path}:${s.line}.`,
          patches: [{ path: s.path, search: s.code, replace: replaced }],
          confidence: 0.6,
        };
      }
    }
    return { summary: `[mock] Value is missing before reading .${prop}`, rootCause: `[mock rule: null-property-access] No matching source line was provided for "${prop}".`, patches: [], confidence: 0.3 };
  }
  const fn = /(?:^|\s)([\w$.]+) is not a function/.exec(msg)?.[1];
  if (fn) {
    const name = fn.split(".").pop() as string;
    for (const s of ctx.sources) {
      const idx = s.code.indexOf(`${name}(`);
      if (idx > 0 && /[\w$\])]\./.test(s.code.slice(idx - 2, idx))) {
        const replaced = `${s.code.slice(0, idx)}${name}?.(${s.code.slice(idx + name.length + 1)}`;
        return {
          summary: `[mock] Only call ${fn} when it exists (${s.path}:${s.line})`,
          rootCause: `[mock rule: not-a-function] ${fn} is not callable at ${s.path}:${s.line}; it is undefined or has the wrong type.`,
          patches: [{ path: s.path, search: s.code, replace: replaced }],
          confidence: 0.4,
        };
      }
    }
    return { summary: `[mock] ${fn} is not callable`, rootCause: "[mock rule: not-a-function] No matching call site was provided.", patches: [], confidence: 0.2 };
  }
  if (/ECONNREFUSED|fetch failed|ETIMEDOUT|ENOTFOUND|NetworkError/.test(msg)) {
    return { summary: "[mock] A network dependency is unreachable", rootCause: "[mock rule: network] The app could not reach a service it depends on; check its URL, credentials and availability. No code change suggested.", patches: [], confidence: 0.3 };
  }
  return { summary: "[mock] No automatic fix rule matched this error", rootCause: `[mock] The rule-based mock only recognises common runtime errors; "${ctx.error.type}" needs a real model or a human.`, patches: [], confidence: 0 };
}

registerMockHandler("appkit.suggest_fix", (req) => {
  let ctx: FixContext;
  try {
    ctx = extractJson(userText(req)) as FixContext;
  } catch {
    ctx = { error: { type: "Error", message: userText(req) }, sources: [] };
  }
  return JSON.stringify(mockSuggestFix({ error: ctx.error ?? { type: "Error", message: "" }, sources: ctx.sources ?? [] }));
});

registerMockHandler("appkit.gateway.chat", (req) => {
  const last = [...req.messages].reverse().find((m) => m.role === "user");
  const text = last ? (typeof last.content === "string" ? last.content : "") : "";
  return `[mock reply] Received ${text.length} characters: "${text.slice(0, 120)}"`;
});
