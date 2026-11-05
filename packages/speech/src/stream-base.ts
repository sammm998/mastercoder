import type { SttStreamEvents, Transcript, TranscriptSegment } from "./types.js";

type Listeners = { [K in keyof SttStreamEvents]: Array<SttStreamEvents[K]> };

/** Minimal typed event emitter shared by every SttStream implementation (no Node EventEmitter). */
export class StreamEmitter {
  private listeners: Listeners = { partial: [], final: [], error: [] };
  on<K extends keyof SttStreamEvents>(event: K, cb: SttStreamEvents[K]): void {
    (this.listeners[event] as Array<SttStreamEvents[K]>).push(cb);
  }
  protected emitPartial(text: string): void {
    for (const cb of this.listeners.partial) cb({ text });
  }
  protected emitFinal(seg: TranscriptSegment): void {
    for (const cb of this.listeners.final) cb(seg);
  }
  protected emitError(err: Error): void {
    for (const cb of this.listeners.error) cb(err);
  }
  protected hasErrorListener(): boolean {
    return this.listeners.error.length > 0;
  }
}

/** Assemble the transcript returned by `SttStream.close()` from the final segments seen. */
export function transcriptFromSegments(
  segments: TranscriptSegment[],
  meta: { language: string; durationSec: number; provider: string; model: string; words?: Transcript["words"] },
): Transcript {
  const t: Transcript = {
    text: segments.map((s) => s.text).filter(Boolean).join(" "),
    language: meta.language,
    durationSec: meta.durationSec,
    segments,
    provider: meta.provider,
    model: meta.model,
  };
  if (meta.words && meta.words.length) t.words = meta.words;
  return t;
}
