/** Tolerant readers for meeting transcript/extraction JSON written by @forge/meetings. */

export interface Segment {
  speaker: string | null;
  text: string;
  startSec: number | null;
}

export function transcriptSegments(t: unknown): Segment[] {
  if (!t) return [];
  if (typeof t === "string") return [{ speaker: null, text: t, startSec: null }];
  const arr = Array.isArray(t) ? t : Array.isArray((t as { segments?: unknown }).segments) ? (t as { segments: unknown[] }).segments : typeof (t as { text?: unknown }).text === "string" ? [t] : [];
  return arr
    .map((s): Segment | null => {
      if (typeof s === "string") return { speaker: null, text: s, startSec: null };
      if (!s || typeof s !== "object") return null;
      const o = s as Record<string, unknown>;
      const text = typeof o.text === "string" ? o.text : null;
      if (!text) return null;
      const start = typeof o.start === "number" ? o.start : typeof o.startSec === "number" ? o.startSec : typeof o.startMs === "number" ? o.startMs / 1000 : null;
      const speaker = typeof o.speaker === "string" ? o.speaker : typeof o.speaker === "number" ? `Speaker ${o.speaker + 1}` : null;
      return { speaker, text, startSec: start };
    })
    .filter((s): s is Segment => s !== null);
}

const asList = (v: unknown): string[] =>
  Array.isArray(v)
    ? v
        .map((x) => (typeof x === "string" ? x : x && typeof x === "object" ? String((x as Record<string, unknown>).text ?? (x as Record<string, unknown>).title ?? (x as Record<string, unknown>).description ?? JSON.stringify(x)) : String(x)))
        .filter(Boolean)
    : [];

export interface Extraction {
  summary: string | null;
  decisions: string[];
  requirements: string[];
  openQuestions: string[];
  actionItems: string[];
}

export function readExtraction(x: unknown): Extraction {
  const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  return {
    summary: typeof o.summary === "string" ? o.summary : null,
    decisions: asList(o.decisions),
    requirements: asList(o.requirements),
    openQuestions: asList(o.openQuestions ?? o.questions),
    actionItems: asList(o.actionItems ?? o.actions),
  };
}

export function timestamp(sec: number | null): string {
  if (sec === null) return "";
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
