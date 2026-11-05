/** Helpers for realtime collaboration (pure; unit-tested). */

export const PEER_COLORS = ["#ff6a2b", "#2b9e8b", "#7a5af8", "#e0a100", "#e0447b", "#3b82c4", "#6f9e2b", "#c4513b"] as const;

/** Stable colour for a person (same name → same colour across sessions). */
export function colorFor(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return PEER_COLORS[Math.abs(h) % PEER_COLORS.length]!;
}

export function initials(name: string): string {
  const parts = name.trim().split(/[\s@._-]+/).filter(Boolean);
  if (!parts.length) return "?";
  return ((parts[0]![0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1]![0] ?? "") : "")).toUpperCase();
}

/**
 * Smallest single splice turning `a` into `b` (common prefix/suffix trimmed). Used to apply a
 * whole-file rewrite (e.g. a visual edit) to a shared Y.Text without clobbering remote cursors.
 */
export function minimalSplice(a: string, b: string): { index: number; remove: number; insert: string } | null {
  if (a === b) return null;
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  return { index: start, remove: endA - start, insert: b.slice(start, endB) };
}

export interface Peer {
  clientId: number;
  name: string;
  color: string;
  self: boolean;
}

/** Turn Yjs awareness states into a de-duplicated, ordered peer list. */
export function peersFromAwareness(states: Map<number, Record<string, unknown>>, selfId: number): Peer[] {
  const out: Peer[] = [];
  for (const [clientId, state] of states) {
    const user = state.user as { name?: unknown; color?: unknown } | undefined;
    if (!user || typeof user.name !== "string") continue;
    out.push({ clientId, name: user.name, color: typeof user.color === "string" ? user.color : colorFor(user.name), self: clientId === selfId });
  }
  return out.sort((a, b) => (a.self === b.self ? a.clientId - b.clientId : a.self ? -1 : 1));
}

/** CSS for y-monaco remote selections/carets, one rule set per peer colour. */
export function remoteCursorCss(peers: Peer[]): string {
  return peers
    .filter((p) => !p.self)
    .map((p) => {
      const safeName = p.name.replace(/["\\\n]/g, "").slice(0, 40);
      return [
        `.yRemoteSelection-${p.clientId}{background-color:${p.color}33}`,
        `.yRemoteSelectionHead-${p.clientId}{position:absolute;border-left:2px solid ${p.color};height:100%;box-sizing:border-box}`,
        `.yRemoteSelectionHead-${p.clientId}::after{content:"${safeName}";position:absolute;top:-1.35em;left:-2px;padding:0 6px;border-radius:3px 3px 3px 0;background:${p.color};color:#17140f;font:600 10px/1.5 var(--font-body);white-space:nowrap;pointer-events:none}`,
      ].join("\n");
    })
    .join("\n");
}
