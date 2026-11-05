import { createHash } from "node:crypto";
import { ForgeError, type CostEstimate, type UsageSink } from "@forge/shared";
import type { MeterContext, SttProvider, SttStream, StreamOptions, TranscribeOptions, Transcript, TranscriptSegment, TranscriptWord } from "./types.js";
import { STT_PRICES, recordTranscription, sttEstimate } from "./pricing.js";
import { StreamEmitter } from "./stream-base.js";
import { WavFormatError, decodeWavHeader, encodeWav, isWav, pcmDurationSec } from "./wav.js";

/**
 * Deterministic offline STT. It never calls a vendor and labels its output as mock unless the audio's
 * sha256 is registered in a fixture registry (eval fixtures with known reference transcripts).
 *   - duration: decoded from the WAV header (non-WAV input → duration 0, reported in the text)
 *   - registered audio → the registered transcript, timings spread over the real duration
 *   - otherwise → "[mock transcript: N.N s of audio]"
 */
export interface MockFixture {
  /** Plain text, or speaker-labelled lines ("Anna: Hej ...") which become diarized segments. */
  text: string;
  language?: string;
}

export class MockTranscriptRegistry {
  private readonly map = new Map<string, MockFixture>();
  register(sha256: string, fixture: MockFixture | string): void {
    this.map.set(sha256.toLowerCase(), typeof fixture === "string" ? { text: fixture } : fixture);
  }
  /** Register by audio bytes; returns the sha256. */
  registerAudio(audio: Uint8Array, fixture: MockFixture | string): string {
    const sha = sha256Hex(audio);
    this.register(sha, fixture);
    return sha;
  }
  lookup(sha256: string): MockFixture | undefined {
    return this.map.get(sha256.toLowerCase());
  }
  get size(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
}

/** Process-wide registry used by `createSttProvider()` in mock mode. */
export const mockTranscriptRegistry = new MockTranscriptRegistry();

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const LABELLED_LINE = /^\s*([^:\n]{1,40}?):\s+(.+)$/;

/** Parse fixture text into (speaker?, text) parts. Only treated as labelled if every non-empty line is. */
export function parseLabelledText(text: string): Array<{ speaker?: string; text: string }> {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const labelled = lines.length > 0 && lines.every((l) => LABELLED_LINE.test(l));
  if (!labelled) return [{ text: lines.join(" ") }];
  return lines.map((l) => {
    const m = l.match(LABELLED_LINE) as RegExpMatchArray;
    return { speaker: (m[1] as string).trim(), text: (m[2] as string).trim() };
  });
}

/** Spread parts over `durationSec` proportionally to their length; words evenly within each part. */
function timedTranscript(parts: Array<{ speaker?: string; text: string }>, durationSec: number, diarize: boolean): { segments: TranscriptSegment[]; words: TranscriptWord[] } {
  const totalChars = parts.reduce((a, p) => a + p.text.length, 0) || 1;
  const segments: TranscriptSegment[] = [];
  const words: TranscriptWord[] = [];
  let t = 0;
  for (const p of parts) {
    const len = (durationSec * p.text.length) / totalChars;
    const seg: TranscriptSegment = { start: round3(t), end: round3(t + len), text: p.text };
    if (diarize && p.speaker) seg.speaker = p.speaker;
    segments.push(seg);
    const toks = p.text.split(/\s+/).filter(Boolean);
    const per = toks.length ? len / toks.length : 0;
    toks.forEach((w, i) => {
      const word: TranscriptWord = { text: w, start: round3(t + i * per), end: round3(t + (i + 1) * per) };
      if (seg.speaker) word.speaker = seg.speaker;
      words.push(word);
    });
    t += len;
  }
  return { segments, words };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export interface MockSttOptions {
  registry?: MockTranscriptRegistry;
  usage?: UsageSink;
  meter?: MeterContext;
}

export class MockSttProvider implements SttProvider {
  readonly name = "mock";
  readonly isMock = true;
  readonly model = "mock-stt";
  readonly registry: MockTranscriptRegistry;
  constructor(private readonly opts: MockSttOptions = {}) {
    this.registry = opts.registry ?? mockTranscriptRegistry;
  }

  estimate(durationSec: number, o?: { streaming?: boolean; diarize?: boolean }): CostEstimate {
    return sttEstimate(STT_PRICES.mock, durationSec, o);
  }

  /** Build a transcript for audio bytes (shared by batch and stream). `alsoSha` lets streams match raw PCM too. */
  build(audio: Uint8Array, o: { language: string; diarize?: boolean; durationSec?: number; alsoSha?: string[] }): Transcript {
    let durationSec = o.durationSec ?? 0;
    let note = "";
    if (o.durationSec === undefined) {
      if (isWav(audio)) {
        try {
          durationSec = decodeWavHeader(audio).durationSec;
        } catch (e) {
          if (!(e instanceof WavFormatError)) throw e;
          note = "unreadable WAV header";
        }
      } else note = `non-WAV audio, ${audio.byteLength} bytes`;
    }
    const shas = [sha256Hex(audio), ...(o.alsoSha ?? [])];
    const fixture = shas.map((s) => this.registry.lookup(s)).find(Boolean);
    if (fixture) {
      const parts = parseLabelledText(fixture.text);
      const { segments, words } = timedTranscript(parts, durationSec, Boolean(o.diarize));
      return { text: parts.map((p) => p.text).join(" "), language: fixture.language ?? o.language, durationSec, segments, words, provider: this.name, model: this.model };
    }
    const text = note ? `[mock transcript: ${note}]` : `[mock transcript: ${durationSec.toFixed(1)} s of audio]`;
    return { text, language: o.language, durationSec, segments: [{ start: 0, end: durationSec, text }], provider: this.name, model: this.model };
  }

  async transcribe(audio: Uint8Array, o: TranscribeOptions): Promise<Transcript> {
    if (!audio.byteLength) throw new ForgeError("BAD_INPUT", "Empty audio");
    const t = this.build(audio, { language: o.language, diarize: o.diarize });
    await recordTranscription(this.opts.usage, STT_PRICES.mock, t.durationSec, { ctx: this.opts.meter });
    return t;
  }

  async openStream(o: StreamOptions): Promise<SttStream> {
    return new MockStream(this, o, (sec) => recordTranscription(this.opts.usage, STT_PRICES.mock, sec, { streaming: true, ctx: this.opts.meter }));
  }
}

class MockStream extends StreamEmitter implements SttStream {
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private lastPartialSec = 0;
  private closed = false;
  constructor(
    private readonly p: MockSttProvider,
    private readonly o: StreamOptions,
    private readonly onDone: (sec: number) => Promise<void>,
  ) {
    super();
  }
  private get sec(): number {
    return this.o.encoding === "pcm16" ? pcmDurationSec(this.bytes, this.o.sampleRate, this.o.channels ?? 1) : 0;
  }
  send(chunk: Uint8Array): void {
    if (this.closed) throw new ForgeError("BAD_INPUT", "SttStream already closed");
    const copy = new Uint8Array(chunk.byteLength);
    copy.set(chunk);
    this.chunks.push(copy);
    this.bytes += copy.byteLength;
    if (this.o.encoding === "pcm16" && Math.floor(this.sec) > this.lastPartialSec) {
      this.lastPartialSec = Math.floor(this.sec);
      this.emitPartial(`[mock partial: ${this.sec.toFixed(1)} s received]`);
    }
  }
  async close(): Promise<Transcript> {
    this.closed = true;
    const pcm = new Uint8Array(this.bytes);
    let off = 0;
    for (const c of this.chunks) {
      pcm.set(c, off);
      off += c.byteLength;
    }
    let t: Transcript;
    if (this.o.encoding === "pcm16") {
      // Match fixtures registered either by their WAV file or by raw PCM.
      const wav = encodeWav(pcm, { sampleRate: this.o.sampleRate, channels: this.o.channels ?? 1 });
      t = this.p.build(wav, { language: this.o.language, diarize: this.o.diarize, alsoSha: [sha256Hex(pcm)] });
    } else {
      t = this.p.build(pcm, { language: this.o.language, diarize: this.o.diarize, durationSec: 0 });
      if (!this.p.registry.lookup(sha256Hex(pcm))) {
        const text = `[mock transcript: opus stream, ${this.bytes} bytes]`;
        t = { ...t, text, segments: [{ start: 0, end: 0, text }], words: undefined };
      }
    }
    for (const s of t.segments) this.emitFinal(s);
    await this.onDone(t.durationSec);
    return t;
  }
}
