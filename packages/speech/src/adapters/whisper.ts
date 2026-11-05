import { z } from "zod";
import { ForgeError, type CostEstimate, type UsageSink } from "@forge/shared";
import type { MeterContext, SttProvider, SttStream, StreamOptions, TranscribeOptions, Transcript, TranscriptSegment, TranscriptWord } from "../types.js";
import { recordTranscription, sttEstimate, whisperPrice, type SttPrice } from "../pricing.js";
import { segmentsFromWords } from "../diarization.js";
import { StreamEmitter, transcriptFromSegments } from "../stream-base.js";
import { bytesToInt16, decodeWavHeader, encodeWav, isWav, pcmDurationSec } from "../wav.js";
import { audioBlob, extensionForMime, fetchJson, type FetchLike } from "./http.js";

/**
 * Self-hosted Whisper behind an OpenAI-compatible API (faster-whisper-server / speaches, vLLM, whisper.cpp server)
 * for customers whose audio must stay on Forge's EU servers. Recommended model for Swedish: KBLab/kb-whisper-large.
 *   POST {WHISPER_URL}/v1/audio/transcriptions  multipart: file, model, language, response_format=verbose_json,
 *        timestamp_granularities[]=segment|word      (https://platform.openai.com/docs/api-reference/audio/createTranscription)
 * Streaming is emulated: PCM is buffered and cut into windows (at the quietest 50 ms frame near the window end, to avoid
 * splitting words); each window is transcribed as a WAV file and emitted as `final` segments with absolute timestamps.
 * No `partial` events are emitted (Whisper has no interim results). Whisper has no diarization: `diarize` is ignored.
 */
export interface WhisperSttOptions {
  baseUrl: string;
  model?: string;
  apiKey?: string;
  usage?: UsageSink;
  meter?: MeterContext;
  price?: SttPrice;
  fetch?: FetchLike;
  /** Streaming window length in seconds (default 8). */
  windowSec?: number;
}

const VerboseSchema = z.object({
  text: z.string(),
  language: z.string().optional(),
  duration: z.number().optional(),
  segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() }).passthrough()).optional(),
  words: z.array(z.object({ word: z.string(), start: z.number(), end: z.number() }).passthrough()).optional(),
});

/** Whisper reports language names ("swedish"); map back to ISO codes. */
const LANG_NAMES: Record<string, string> = { swedish: "sv", english: "en", norwegian: "no", danish: "da", finnish: "fi", german: "de" };

export class WhisperSttProvider implements SttProvider {
  readonly name = "whisper";
  readonly isMock = false;
  readonly model: string;
  private readonly baseUrl: string;
  readonly price: SttPrice;
  constructor(private readonly opts: WhisperSttOptions) {
    if (!opts.baseUrl) throw new ForgeError("BAD_INPUT", "WhisperSttProvider requires WHISPER_URL");
    this.model = opts.model ?? "KBLab/kb-whisper-large";
    this.baseUrl = opts.baseUrl.replace(/\/$/, "").replace(/\/v1$/, "");
    this.price = opts.price ?? whisperPrice(this.model);
  }

  estimate(durationSec: number, o?: { streaming?: boolean; diarize?: boolean }): CostEstimate {
    return sttEstimate(this.price, durationSec, o);
  }

  /** Raw request without metering (used by both batch and windowed streaming). */
  async request(audio: Uint8Array, o: TranscribeOptions): Promise<Transcript> {
    const form = new FormData();
    form.append("file", audioBlob(audio, o.mimeType), `audio.${extensionForMime(o.mimeType)}`);
    form.append("model", this.model);
    if (o.language) form.append("language", o.language);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    form.append("timestamp_granularities[]", "word");
    const headers: Record<string, string> = {};
    if (this.opts.apiKey) headers.Authorization = `Bearer ${this.opts.apiKey}`;
    const r = await fetchJson("whisper", `${this.baseUrl}/v1/audio/transcriptions`, { method: "POST", headers, body: form, signal: o.signal }, VerboseSchema, this.opts.fetch);
    const words: TranscriptWord[] = (r.words ?? []).map((w) => ({ text: w.word.trim(), start: w.start, end: w.end })).filter((w) => w.text);
    const durationSec = r.duration ?? (isWav(audio) ? decodeWavHeader(audio).durationSec : (r.segments?.[r.segments.length - 1]?.end ?? 0));
    const segments: TranscriptSegment[] = r.segments?.length
      ? r.segments.map((s) => ({ start: s.start, end: s.end, text: s.text.trim() })).filter((s) => s.text)
      : words.length
        ? segmentsFromWords(words)
        : r.text.trim()
          ? [{ start: 0, end: durationSec, text: r.text.trim() }]
          : [];
    const lang = r.language ? (LANG_NAMES[r.language.toLowerCase()] ?? r.language.toLowerCase()) : o.language;
    const t: Transcript = { text: r.text.trim(), language: lang, durationSec, segments, provider: this.name, model: this.model };
    if (words.length) t.words = words;
    return t;
  }

  async transcribe(audio: Uint8Array, o: TranscribeOptions): Promise<Transcript> {
    const t = await this.request(audio, o);
    await recordTranscription(this.opts.usage, this.price, t.durationSec, { model: this.model, ctx: this.opts.meter });
    return t;
  }

  async openStream(o: StreamOptions): Promise<SttStream> {
    if (o.encoding !== "pcm16") throw new ForgeError("BAD_INPUT", "Whisper windowed streaming accepts pcm16 only");
    return new WhisperWindowStream(this, o, this.opts.windowSec ?? 8, (sec) =>
      recordTranscription(this.opts.usage, this.price, sec, { streaming: true, model: this.model, ctx: this.opts.meter }),
    );
  }
}

/** Find a cut point (byte offset, frame aligned) at the quietest 50 ms frame in the last `searchSec` of `pcm` (ties → latest). */
export function quietCutPoint(pcm: Uint8Array, sampleRate: number, channels: number, searchSec = 1.5): number {
  const frameBytes = Math.max(2 * channels, Math.floor(sampleRate * 0.05) * 2 * channels);
  const searchStart = Math.max(0, pcm.byteLength - Math.floor(searchSec * sampleRate) * 2 * channels);
  let best = pcm.byteLength - (pcm.byteLength % (2 * channels));
  let bestEnergy = Infinity;
  for (let off = searchStart - (searchStart % frameBytes); off + frameBytes <= pcm.byteLength; off += frameBytes) {
    const s = bytesToInt16(pcm.subarray(off, off + frameBytes));
    let e = 0;
    for (const v of s) e += v * v;
    if (e <= bestEnergy) {
      bestEnergy = e;
      best = off + frameBytes / 2 - ((frameBytes / 2) % (2 * channels));
    }
  }
  return best;
}

class WhisperWindowStream extends StreamEmitter implements SttStream {
  private buf: Uint8Array[] = [];
  private bufBytes = 0;
  private offsetSec = 0;
  private totalBytes = 0;
  private segments: TranscriptSegment[] = [];
  private words: TranscriptWord[] = [];
  private chain: Promise<void> = Promise.resolve();
  private closing = false;
  private failure: Error | undefined;
  private readonly bytesPerSec: number;

  constructor(
    private readonly p: WhisperSttProvider,
    private readonly o: StreamOptions,
    private readonly windowSec: number,
    private readonly onDone: (sec: number) => Promise<void>,
  ) {
    super();
    this.bytesPerSec = o.sampleRate * 2 * (o.channels ?? 1);
  }

  send(chunk: Uint8Array): void {
    if (this.closing) throw new ForgeError("BAD_INPUT", "SttStream already closed");
    const copy = new Uint8Array(chunk.byteLength);
    copy.set(chunk);
    this.buf.push(copy);
    this.bufBytes += copy.byteLength;
    this.totalBytes += copy.byteLength;
    if (this.bufBytes >= this.windowSec * this.bytesPerSec) this.cut(false);
  }

  private takeBuffer(): Uint8Array {
    const all = new Uint8Array(this.bufBytes);
    let o = 0;
    for (const b of this.buf) {
      all.set(b, o);
      o += b.byteLength;
    }
    return all;
  }

  private cut(final: boolean): void {
    const all = this.takeBuffer();
    const at = final ? all.byteLength : quietCutPoint(all, this.o.sampleRate, this.o.channels ?? 1, Math.min(1.5, this.windowSec * 0.25));
    const window = all.subarray(0, at);
    const rest = all.subarray(at);
    this.buf = rest.byteLength ? [rest] : [];
    this.bufBytes = rest.byteLength;
    const startSec = this.offsetSec;
    this.offsetSec += window.byteLength / this.bytesPerSec;
    if (window.byteLength < 0.2 * this.bytesPerSec) return; // < 200 ms: nothing to transcribe
    const wav = encodeWav(window, { sampleRate: this.o.sampleRate, channels: this.o.channels ?? 1 });
    this.chain = this.chain.then(async () => {
      try {
        const t = await this.p.request(wav, { mimeType: "audio/wav", language: this.o.language });
        for (const s of t.segments) {
          const seg = { start: s.start + startSec, end: s.end + startSec, text: s.text };
          this.segments.push(seg);
          this.emitFinal(seg);
        }
        for (const w of t.words ?? []) this.words.push({ ...w, start: w.start + startSec, end: w.end + startSec });
      } catch (e) {
        this.failure = e as Error;
        this.emitError(e as Error);
      }
    });
  }

  async close(): Promise<Transcript> {
    this.closing = true;
    if (this.bufBytes > 0) this.cut(true);
    await this.chain;
    const durationSec = pcmDurationSec(this.totalBytes, this.o.sampleRate, this.o.channels ?? 1);
    await this.onDone(durationSec);
    if (this.failure && this.segments.length === 0) throw this.failure;
    return transcriptFromSegments(this.segments, { language: this.o.language, durationSec, provider: this.p.name, model: this.p.model, words: this.words });
  }
}
