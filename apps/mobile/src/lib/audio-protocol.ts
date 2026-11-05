/**
 * Client side of the streaming voice-prompt protocol over `/ws/audio/:projectId?lang=sv|en`.
 *
 * Client → server
 *   text   {"type":"start","encoding":"pcm_s16le","sampleRate":16000,"channels":1,"language":"sv"}
 *   binary raw little-endian 16-bit PCM frames
 *   text   {"type":"stop"}   — end of speech; the server flushes the final transcript
 * Server → client (parsed leniently; see parseAudioServerMessage)
 *   {"type":"transcript","text":"…","isFinal":false|true}   (also accepted: {"type":"partial"|"final","text"})
 *   {"type":"error","message":"…"}
 *   {"type":"done"}
 *
 * The gateway route exists in apps/api but its AudioStreamHandler (wired to @forge/speech) defines the server
 * half; this module is the contract the mobile app speaks. Close code 4501 means speech is not configured.
 */

export interface AudioFormat {
  sampleRate: number;
  channels: number;
}

export function startMessage(f: AudioFormat, language: "sv" | "en"): string {
  return JSON.stringify({ type: "start", encoding: "pcm_s16le", sampleRate: Math.round(f.sampleRate), channels: f.channels, language });
}

export const STOP_MESSAGE = JSON.stringify({ type: "stop" });

export type AudioServerMessage =
  | { type: "transcript"; text: string; isFinal: boolean }
  | { type: "error"; message: string }
  | { type: "done" };

export function parseAudioServerMessage(raw: string): AudioServerMessage | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const text = typeof o.text === "string" ? o.text : typeof o.transcript === "string" ? o.transcript : null;
  switch (o.type) {
    case "transcript":
      if (text === null) return null;
      return { type: "transcript", text, isFinal: o.isFinal === true || o.final === true || o.is_final === true };
    case "partial":
      return text === null ? null : { type: "transcript", text, isFinal: false };
    case "final":
      return text === null ? null : { type: "transcript", text, isFinal: true };
    case "error":
      return { type: "error", message: typeof o.message === "string" ? o.message : "error" };
    case "done":
    case "end":
      return { type: "done" };
    default:
      return null;
  }
}

export interface TranscriptState {
  finals: string[];
  partial: string;
}

export const emptyTranscript: TranscriptState = { finals: [], partial: "" };

export function reduceTranscript(s: TranscriptState, m: AudioServerMessage): TranscriptState {
  if (m.type !== "transcript") return s;
  const text = m.text.trim();
  if (m.isFinal) return { finals: text ? [...s.finals, text] : s.finals, partial: "" };
  return { ...s, partial: text };
}

export function transcriptText(s: TranscriptState): string {
  return [...s.finals, s.partial].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

/** Convert float32 PCM [-1, 1] to little-endian int16 PCM. */
export function float32ToInt16(input: Float32Array): ArrayBuffer {
  const out = new ArrayBuffer(input.length * 2);
  const view = new DataView(out);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

/** Peak level of an int16 PCM buffer in [0, 1] (for the input meter). */
export function peakLevel(pcm16: ArrayBuffer): number {
  const v = new Int16Array(pcm16, 0, Math.floor(pcm16.byteLength / 2));
  let peak = 0;
  for (let i = 0; i < v.length; i++) {
    const a = Math.abs(v[i] ?? 0);
    if (a > peak) peak = a;
  }
  return Math.min(1, peak / 0x7fff);
}

export interface AudioSink {
  isOpen(): boolean;
  send(data: string | ArrayBuffer): void;
}

/**
 * Sends `start` once with the actual capture format (known from the first buffer), queues frames while the
 * socket is still connecting (bounded to `maxQueuedBytes`, oldest dropped), and sends `stop` exactly once.
 */
export class AudioStreamSession {
  private started = false;
  private stopped = false;
  private format: AudioFormat | null = null;
  private queue: ArrayBuffer[] = [];
  private queuedBytes = 0;
  dropped = 0;
  sentBytes = 0;

  constructor(
    private readonly sink: AudioSink,
    private readonly language: "sv" | "en",
    private readonly maxQueuedBytes = 16000 * 2 * 15,
  ) {}

  push(frame: ArrayBuffer, f: AudioFormat): void {
    if (this.stopped) return;
    this.format ??= f;
    this.queue.push(frame);
    this.queuedBytes += frame.byteLength;
    while (this.queuedBytes > this.maxQueuedBytes && this.queue.length > 1) {
      const old = this.queue.shift();
      this.queuedBytes -= old?.byteLength ?? 0;
      this.dropped++;
    }
    this.flush();
  }

  /** Call when the socket opens to drain queued audio. */
  flush(): void {
    if (!this.sink.isOpen() || !this.format) return;
    if (!this.started) {
      this.sink.send(startMessage(this.format, this.language));
      this.started = true;
    }
    while (this.queue.length) {
      const f = this.queue.shift() as ArrayBuffer;
      this.queuedBytes -= f.byteLength;
      this.sink.send(f);
      this.sentBytes += f.byteLength;
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.flush();
    this.stopped = true;
    if (this.sink.isOpen() && this.started) this.sink.send(STOP_MESSAGE);
  }

  get isStopped(): boolean {
    return this.stopped;
  }
}
