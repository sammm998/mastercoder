/** Extract the first JSON object/array from model text (handles ```json fences and prose). */
export function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence?.[1] ?? text;
  const start = candidate.search(/[[{]/);
  if (start === -1) throw new Error("No JSON found in text");
  const open = candidate[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const c = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return JSON.parse(candidate.slice(start, i + 1));
    }
  }
  throw new Error("Unterminated JSON in text");
}

/** Deterministic JSON stringify (sorted keys) - used for prompt-cache-stable payloads and hashing. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}
