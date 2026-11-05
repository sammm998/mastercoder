import type { Transcript, TranscriptSegment, TranscriptWord } from "./types.js";

/**
 * Vendors label speakers differently ("speaker_0", 0, "SPEAKER_01", "A"). Forge normalizes to
 * "Speaker 1", "Speaker 2", ... in order of first appearance, so labels are stable across providers.
 */
export class SpeakerLabeler {
  private map = new Map<string, string>();
  label(raw: string | number | null | undefined): string | undefined {
    if (raw === null || raw === undefined || raw === "") return undefined;
    const key = String(raw);
    let l = this.map.get(key);
    if (!l) {
      l = `Speaker ${this.map.size + 1}`;
      this.map.set(key, l);
    }
    return l;
  }
  get mapping(): ReadonlyMap<string, string> {
    return this.map;
  }
}

/** Re-label every speaker in a transcript (segments + words share one mapping). */
export function normalizeSpeakers(t: Transcript): Transcript {
  const l = new SpeakerLabeler();
  // Words first so order of appearance follows the audio when words exist.
  const words = t.words?.map((w) => ({ ...w, speaker: l.label(w.speaker) }));
  const segments = t.segments.map((s) => ({ ...s, speaker: l.label(s.speaker) }));
  return { ...t, segments: segments.map(stripUndefinedSpeaker), words: words?.map(stripUndefinedSpeaker) };
}

function stripUndefinedSpeaker<T extends { speaker?: string }>(x: T): T {
  if (x.speaker === undefined) {
    const { speaker: _s, ...rest } = x;
    return rest as T;
  }
  return x;
}

const SENTENCE_END = /[.!?…]$/;

/**
 * Group timed words into segments: a new segment starts when the speaker changes, on a pause longer
 * than `maxGapSec`, or after sentence-final punctuation once the segment exceeds `maxSegmentSec`.
 */
export function segmentsFromWords(words: TranscriptWord[], opts: { maxGapSec?: number; maxSegmentSec?: number } = {}): TranscriptSegment[] {
  const maxGap = opts.maxGapSec ?? 1.0;
  const maxLen = opts.maxSegmentSec ?? 15;
  const out: TranscriptSegment[] = [];
  let cur: { start: number; end: number; parts: string[]; speaker?: string } | undefined;
  const push = () => {
    if (!cur) return;
    const seg: TranscriptSegment = { start: cur.start, end: cur.end, text: joinWords(cur.parts) };
    if (cur.speaker !== undefined) seg.speaker = cur.speaker;
    out.push(seg);
    cur = undefined;
  };
  for (const w of words) {
    if (cur) {
      const speakerChanged = w.speaker !== cur.speaker;
      const gap = w.start - cur.end > maxGap;
      const last = cur.parts[cur.parts.length - 1] ?? "";
      const longSentence = cur.end - cur.start >= maxLen && SENTENCE_END.test(last);
      if (speakerChanged || gap || longSentence) push();
    }
    if (!cur) cur = { start: w.start, end: w.end, parts: [], speaker: w.speaker };
    cur.parts.push(w.text);
    cur.end = Math.max(cur.end, w.end);
  }
  push();
  return out;
}

/** Join word tokens, attaching punctuation-only tokens to the previous word. */
export function joinWords(parts: string[]): string {
  let s = "";
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    if (!s) s = t;
    else if (/^[.,!?;:…)\]}%]+$/.test(t)) s += t;
    else s += ` ${t}`;
  }
  return s;
}

/** Plain text with speaker prefixes, one segment per line ("Speaker 1: Hej ..."). */
export function transcriptToLabeledText(t: Pick<Transcript, "segments">): string {
  return t.segments.map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text)).join("\n");
}
