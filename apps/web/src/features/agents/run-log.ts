/** Render one entry of an agent run log (agent_runs.log is JSON written by @forge/agents-runtime). */
export function describeLogEntry(entry: unknown): { title: string; detail: string | null; costUsd: number | null } {
  if (typeof entry === "string") return { title: entry, detail: null, costUsd: null };
  if (!entry || typeof entry !== "object") return { title: String(entry), detail: null, costUsd: null };
  const e = entry as Record<string, unknown>;
  const cost = typeof e.costUsd === "number" ? e.costUsd : typeof e.cost === "number" ? e.cost : null;
  const tool = typeof e.tool === "string" ? e.tool : typeof e.name === "string" && e.type === "tool" ? e.name : null;
  const kind = typeof e.type === "string" ? e.type : typeof e.kind === "string" ? e.kind : null;
  const title = [kind, tool].filter(Boolean).join(" · ") || (typeof e.message === "string" ? e.message.slice(0, 120) : "step");
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) if (!["type", "kind", "tool", "costUsd", "cost"].includes(k) && !(k === "message" && title === v)) rest[k] = v;
  const detail = Object.keys(rest).length ? JSON.stringify(rest, null, 2).slice(0, 4000) : null;
  return { title, detail, costUsd: cost };
}
