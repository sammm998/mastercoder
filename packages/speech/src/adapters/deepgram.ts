import { z } from "zod";
import { ForgeError, type CostEstimate, type UsageSink } from "@forge/shared";
import type { MeterContext, SttProvider, SttStream, StreamOptions, TranscribeOptions, Transcript, TranscriptSegment, TranscriptWord } from "../types.js";
import { STT_PRICES, recordTranscription, sttEstimate, type SttPrice } from "../pricing.js";
import { SpeakerLabeler, segmentsFromWords } from "../diarization.js";
import { StreamEmitter, transcriptFromSegments } from "../stream-base.js";
import { pcmDurationSec } from "../wav.js";
import { fetchJson, type FetchLike } from "./http.js";
import { QueuedSocket, nodeWebSocketFactory, withTimeout, type WebSocketFactory } from "./ws.js";

/**
 * Deepgram Nova-3.
 * Pre-recorded: POST {base}/v1/listen?model=nova-3&language=sv&diarize=true&smart_format=true (raw audio body)
 *               https://developers.deepgram.com/reference/speech-to-text-api/listen
 * Streaming:    wss://{host}/v1/listen?model=nova-3&encoding=linear16|opus&sample_rate=..&interim_results=true
 *               binary audio frames; {"type":"KeepAlive"}; {"type":"CloseStream"} flushes and closes.
 *               https://developers.deepgram.com/reference/speech-to-text-api/listen-streaming
 * Auth header: `Authorization: Token <key>`. EU endpoint: set DEEPGRAM_BASE_URL=https://api.eu.deepgram.com.
 */
export interface DeepgramSttOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  usage?: UsageSink;
  meter?: MeterContext;
  price?: SttPrice;
  fetch?: FetchLike;
  wsFactory?: WebSocketFactory;
  closeTimeoutMs?: number;
  keepAliveMs?: number;
}

const DgWord = z.object({
  word: z.string(),
  punctuated_word: z.string().optional(),
  start: z.number(),
  end: z.number(),
  confidence: z.number().optional(),
  speaker: z.number().optional(),
});

const PrerecordedSchema = z.object({
  metadata: z.object({ duration: z.number().optional(), request_id: z.string().optional() }).passthrough(),
  results: z.object({
    channels: z.array(
      z.object({
        detected_language: z.string().optional(),
        alternatives: z.array(z.object({ transcript: z.string(), words: z.array(DgWord).default([]) })),
      }),
    ),
    utterances: z
      .array(z.object({ start: z.number(), end: z.number(), transcript: z.string(), speaker: z.number().optional() }))
      .optional(),
  }),
});

const StreamMsg = z
  .object({
    type: z.string(),
    is_final: z.boolean().optional(),
    speech_final: z.boolean().optional(),
    start: z.number().optional(),
    duration: z.number().optional(),
    channel: z.object({ alternatives: z.array(z.object({ transcript: z.string(), words: z.array(DgWord).default([]) })) }).optional(),
    description: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

function mapWords(words: z.infer<typeof DgWord>[], labeler: SpeakerLabeler): TranscriptWord[] {
  return words.map((w) => {
    const out: TranscriptWord = { text: w.punctuated_word ?? w.word, start: w.start, end: w.end };
    const sp = labeler.label(w.speaker);
    if (sp) out.speaker = sp;
    return out;
  });
}

export class DeepgramSttProvider implements SttProvider {
  readonly name = "deepgram";
  readonly isMock = false;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly price: SttPrice;
  constructor(private readonly opts: DeepgramSttOptions) {
    if (!opts.apiKey) throw new ForgeError("BAD_INPUT", "DeepgramSttProvider requires DEEPGRAM_API_KEY");
    this.model = opts.model ?? "nova-3";
    this.baseUrl = (opts.baseUrl ?? "https://api.deepgram.com").replace(/\/$/, "");
    this.price = opts.price ?? { ...STT_PRICES.deepgram, model: this.model };
  }

  estimate(durationSec: number, o?: { streaming?: boolean; diarize?: boolean }): CostEstimate {
    return sttEstimate(this.price, durationSec, o);
  }

  async transcribe(audio: Uint8Array, o: TranscribeOptions): Promise<Transcript> {
    const q = new URLSearchParams({ model: this.model, smart_format: "true", punctuate: "true", utterances: "true" });
    if (o.language) q.set("language", o.language);
    if (o.diarize) q.set("diarize", "true");
    const body = new Uint8Array(audio.byteLength);
    body.set(audio);
    const r = await fetchJson(
      "deepgram",
      `${this.baseUrl}/v1/listen?${q}`,
      { method: "POST", headers: { Authorization: `Token ${this.opts.apiKey}`, "Content-Type": o.mimeType }, body, signal: o.signal },
      PrerecordedSchema,
      this.opts.fetch,
    );
    const ch = r.results.channels[0];
    const alt = ch?.alternatives[0];
    const labeler = new SpeakerLabeler();
    const words = alt ? mapWords(alt.words, labeler) : [];
    const durationSec = r.metadata.duration ?? (words.length ? (words[words.length - 1]?.end ?? 0) : 0);
    let segments: TranscriptSegment[];
    if (r.results.utterances?.length) {
      segments = r.results.utterances.map((u) => {
        const s: TranscriptSegment = { start: u.start, end: u.end, text: u.transcript.trim() };
        const sp = labeler.label(u.speaker);
        if (o.diarize && sp) s.speaker = sp;
        return s;
      });
    } else segments = segmentsFromWords(words);
    const t: Transcript = {
      text: (alt?.transcript ?? "").trim(),
      language: ch?.detected_language ?? o.language,
      durationSec,
      segments,
      provider: this.name,
      model: this.model,
    };
    if (words.length) t.words = o.diarize ? words : words.map(({ speaker: _s, ...w }) => w);
    await recordTranscription(this.opts.usage, this.price, durationSec, { diarize: o.diarize, model: this.model, ctx: this.opts.meter });
    return t;
  }

  async openStream(o: StreamOptions): Promise<SttStream> {
    const wsBase = this.baseUrl.replace(/^http/, "ws");
    const q = new URLSearchParams({
      model: this.model,
      encoding: o.encoding === "opus" ? "opus" : "linear16",
      sample_rate: String(o.sampleRate),
      channels: String(o.channels ?? 1),
      interim_results: "true",
      smart_format: "true",
      punctuate: "true",
    });
    if (o.language) q.set("language", o.language);
    if (o.diarize) q.set("diarize", "true");
    const ws = (this.opts.wsFactory ?? nodeWebSocketFactory)(`${wsBase}/v1/listen?${q}`, { Authorization: `Token ${this.opts.apiKey}` });
    return new DeepgramStream(new QueuedSocket(ws), o, {
      provider: this.name,
      model: this.model,
      closeTimeoutMs: this.opts.closeTimeoutMs ?? 10_000,
      keepAliveMs: this.opts.keepAliveMs ?? 8_000,
      onDone: (sec) => recordTranscription(this.opts.usage, this.price, sec, { streaming: true, diarize: o.diarize, model: this.model, ctx: this.opts.meter }),
    });
  }
}

class DeepgramStream extends StreamEmitter implements SttStream {
  private bytes = 0;
  private segments: TranscriptSegment[] = [];
  private words: TranscriptWord[] = [];
  private labeler = new SpeakerLabeler();
  private closing = false;
  private failure: Error | undefined;
  private lastSend = Date.now();
  private keepAlive: ReturnType<typeof setInterval>;
  /** Highest end time reported by Deepgram (opus has no byte → seconds mapping). */
  private reportedSec = 0;

  constructor(
    private readonly sock: QueuedSocket,
    private readonly o: StreamOptions,
    private readonly meta: { provider: string; model: string; closeTimeoutMs: number; keepAliveMs: number; onDone: (sec: number) => Promise<void> },
  ) {
    super();
    sock.ws.onMessage((d) => this.onMessage(typeof d === "string" ? d : new TextDecoder().decode(d)));
    sock.ws.onError((e) => {
      this.failure = e;
      this.emitError(e);
    });
    // Deepgram closes idle sockets after ~10 s without audio; KeepAlive prevents that during pauses.
    this.keepAlive = setInterval(() => {
      if (Date.now() - this.lastSend >= meta.keepAliveMs) this.sock.send(JSON.stringify({ type: "KeepAlive" }));
    }, meta.keepAliveMs);
    (this.keepAlive as { unref?: () => void }).unref?.();
  }

  private onMessage(raw: string): void {
    let msg: z.infer<typeof StreamMsg>;
    try {
      msg = StreamMsg.parse(JSON.parse(raw));
    } catch {
      return;
    }
    if (msg.type === "Results") {
      const alt = msg.channel?.alternatives[0];
      if (msg.start !== undefined && msg.duration !== undefined) this.reportedSec = Math.max(this.reportedSec, msg.start + msg.duration);
      if (!alt) return;
      if (!msg.is_final) {
        if (alt.transcript) this.emitPartial(alt.transcript);
        return;
      }
      if (!alt.transcript.trim()) return;
      const words = mapWords(alt.words, this.labeler);
      const start = words[0]?.start ?? msg.start ?? 0;
      const end = words.length ? (words[words.length - 1]?.end ?? start) : (msg.start ?? 0) + (msg.duration ?? 0);
      // A final may span speakers when diarizing: split at speaker changes.
      const segs = this.o.diarize && words.length ? segmentsFromWords(words, { maxGapSec: Infinity, maxSegmentSec: Infinity }) : [{ start, end, text: alt.transcript.trim() }];
      for (const s of segs) {
        this.segments.push(s);
        this.emitFinal(s);
      }
      this.words.push(...(this.o.diarize ? words : words.map(({ speaker: _s, ...w }) => w)));
    } else if (msg.type === "Error" || msg.type === "error") {
      this.failure = new ForgeError("PROVIDER_ERROR", `deepgram stream: ${msg.description ?? msg.message ?? "error"}`);
      this.emitError(this.failure);
    }
  }

  send(chunk: Uint8Array): void {
    if (this.closing) throw new ForgeError("BAD_INPUT", "SttStream already closed");
    this.bytes += chunk.byteLength;
    this.lastSend = Date.now();
    const copy = new Uint8Array(chunk.byteLength);
    copy.set(chunk);
    this.sock.send(copy);
  }

  async close(): Promise<Transcript> {
    this.closing = true;
    clearInterval(this.keepAlive);
    this.sock.send(JSON.stringify({ type: "CloseStream" }));
    const r = await withTimeout(this.sock.closed, this.meta.closeTimeoutMs);
    if (r === "timeout") this.sock.ws.close(1000, "timeout");
    const durationSec =
      this.o.encoding === "pcm16" ? pcmDurationSec(this.bytes, this.o.sampleRate, this.o.channels ?? 1) : this.reportedSec;
    await this.meta.onDone(durationSec);
    if (this.failure && this.segments.length === 0) throw this.failure;
    return transcriptFromSegments(this.segments, { language: this.o.language, durationSec, provider: this.meta.provider, model: this.meta.model, words: this.words });
  }
}
