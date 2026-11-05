/** Helpers for rendering abuse-report evidence (arbitrary JSON from scanners, users or moderation). */

const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/gi;

/** Every http(s) URL found anywhere in the evidence (deduplicated, in discovery order, max `limit`). */
export function extractLinks(evidence: unknown, limit = 50): string[] {
  const out = new Set<string>();
  const visit = (v: unknown, depth: number) => {
    if (out.size >= limit || depth > 8 || v === null || v === undefined) return;
    if (typeof v === "string") {
      for (const m of v.match(URL_RE) ?? []) {
        if (out.size >= limit) return;
        out.add(m.replace(/[),.;]+$/, ""));
      }
    } else if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
    } else if (typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) visit(x, depth + 1);
    }
  };
  visit(evidence, 0);
  return [...out];
}

/** Top-level scalar fields (string/number/boolean) for a compact key/value summary. */
export function scalarFields(evidence: unknown, max = 12): Array<[string, string]> {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return [];
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(evidence as Record<string, unknown>)) {
    if (out.length >= max) break;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out.push([k, String(v).slice(0, 500)]);
  }
  return out;
}

/** Pretty JSON, truncated so a huge payload cannot freeze the page. */
export function prettyJson(evidence: unknown, maxChars = 20_000): string {
  let s: string;
  try {
    s = JSON.stringify(evidence, null, 2) ?? "null";
  } catch {
    s = String(evidence);
  }
  return s.length > maxChars ? `${s.slice(0, maxChars)}\n… (${s.length - maxChars} more characters)` : s;
}
