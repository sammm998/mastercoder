import { z } from "zod";
import { ForgeError, type CostEstimate, type UsageSink } from "@forge/shared";
import type { MeterContext, SttProvider, SttStream, StreamOptions, TranscribeOptions, Transcript, TranscriptSegment, TranscriptWord } from "../types.js";
import { STT_PRICES, recordTranscription, sttEstimate, type SttPrice } from "../pricing.js";
import { SpeakerLabeler, joinWords, segmentsFromWords } from "../diarization.js";
import { StreamEmitter, transcriptFromSegments } from "../stream-base.js";
import { decodeWavHeader, isWav, pcmDurationSec } from "../wav.js";
import { bytesToBase64 } from "../base64.js";
import { audioBlob, extensionForMime, fetchJson, type FetchLike } from "./http.js";
import { QueuedSocket, nodeWebSocketFactory, withTimeout, type WebSocketFactory } from "./ws.js";

/**
 * ElevenLabs Scribe.
 * Batch:     POST {base}/v1/speech-to-text (multipart: model_id, file, language_code, diarize, timestamps_granularity)
 *            https://elevenlabs.io/docs/api-reference/speech-to-text/convert
 * Realtime:  wss://{host}/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&audio_format=pcm_16000&language_code=..
 *            client → {message_type:"input_audio_chunk", audio_base_64, commit, sample_rate}
 *            server → session_started | partial_transcript | committed_transcript | committed_transcript_with_timestamps | *error
 *            https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
 * Auth header: xi-api-key. EU data residency customers set ELEVENLABS_BASE_URL to their residency host.
 */
export interface ElevenLabsSttOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  realtimeModel?: string;
  usage?: UsageSink;
  meter?: MeterContext;
  price?: SttPrice;
  fetch?: FetchLike;
  wsFactory?: WebSocketFactory;
  /** ms to wait for the last committed transcript after close(). */
  closeTimeoutMs?: number;
}

const WordSchema = z.object({
  text: z.string(),
  start: z.number().nullish(),
  end: z.number().nullish(),
  type: z.string().optional(),
  speaker_id: z.string().nullish(),
});

const BatchSchema = z.object({
  language_code: z.string().optional(),
  language_probability: z.number().optional(),
  text: z.string(),
  words: z.array(WordSchema).default([]),
});

const RealtimeMsg = z
  .object({
    message_type: z.string(),
    text: z.string().optional(),
    language_code: z.string().optional(),
    words: z.array(WordSchema).optional(),
    error: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

const PCM_RATES = new Set([8000, 16000, 22050, 24000, 44100, 48000]);

function mapWords(words: z.infer<typeof WordSchema>[], labeler: SpeakerLabeler, offset = 0): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  for (const w of words) {
    if (w.type && w.type !== "word") continue; // drop "spacing" and "audio_event"
    const word: TranscriptWord = { text: w.text, start: (w.start ?? 0) + offset, end: (w.end ?? w.start ?? 0) + offset };
    const sp = labeler.label(w.speaker_id);
    if (sp) word.speaker = sp;
    out.push(word);
  }
  return out;
}

export class ElevenLabsSttProvider implements SttProvider {
  readonly name = "elevenlabs";
  readonly isMock = false;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly price: SttPrice;
  constructor(private readonly opts: ElevenLabsSttOptions) {
    if (!opts.apiKey) throw new ForgeError("BAD_INPUT", "ElevenLabsSttProvider requires ELEVENLABS_API_KEY");
    this.model = opts.model ?? "scribe_v1";
    this.baseUrl = (opts.baseUrl ?? "https://api.elevenlabs.io").replace(/\/$/, "");
    this.price = opts.price ?? { ...STT_PRICES.elevenlabs, model: this.model };
  }

  estimate(durationSec: number, o?: { streaming?: boolean; diarize?: boolean }): CostEstimate {
    return sttEstimate(this.price, durationSec, o);
  }

  async transcribe(audio: Uint8Array, o: TranscribeOptions): Promise<Transcript> {
    const form = new FormData();
    form.append("model_id", this.model);
    form.append("file", audioBlob(audio, o.mimeType), `audio.${extensionForMime(o.mimeType)}`);
    if (o.language) form.append("language_code", o.language);
    form.append("diarize", o.diarize ? "true" : "false");
    form.append("timestamps_granularity", "word");
    form.append("tag_audio_events", "false");
    const r = await fetchJson(
      "elevenlabs",
      `${this.baseUrl}/v1/speech-to-text`,
      { method: "POST", headers: { "xi-api-key": this.opts.apiKey }, body: form, signal: o.signal },
      BatchSchema,
      this.opts.fetch,
    );
    const labeler = new SpeakerLabeler();
    const words = mapWords(r.words, labeler);
    const lastEnd = words.length ? (words[words.length - 1]?.end ?? 0) : 0;
    const durationSec = isWav(audio) ? decodeWavHeader(audio).durationSec : lastEnd;
    const t: Transcript = {
      text: r.text.trim(),
      language: normalizeLang(r.language_code, o.language),
      durationSec,
      segments: words.length ? segmentsFromWords(words) : r.text.trim() ? [{ start: 0, end: durationSec, text: r.text.trim() }] : [],
      provider: this.name,
      model: this.model,
    };
    if (words.length) t.words = words;
    await recordTranscription(this.opts.usage, this.price, durationSec, { diarize: o.diarize, model: this.model, ctx: this.opts.meter });
    return t;
  }

  async openStream(o: StreamOptions): Promise<SttStream> {
    if (o.encoding !== "pcm16") throw new ForgeError("BAD_INPUT", "ElevenLabs realtime STT accepts pcm16 only (send PCM, not opus)");
    if (!PCM_RATES.has(o.sampleRate)) throw new ForgeError("BAD_INPUT", `ElevenLabs realtime: unsupported sample rate ${o.sampleRate}`);
    const wsBase = this.baseUrl.replace(/^http/, "ws");
    const q = new URLSearchParams({
      model_id: this.opts.realtimeModel ?? "scribe_v2_realtime",
      audio_format: `pcm_${o.sampleRate}`,
      commit_strategy: "vad",
      include_timestamps: "true",
    });
    if (o.language) q.set("language_code", o.language);
    const ws = (this.opts.wsFactory ?? nodeWebSocketFactory)(`${wsBase}/v1/speech-to-text/realtime?${q}`, { "xi-api-key": this.opts.apiKey });
    return new ElevenLabsStream(new QueuedSocket(ws), o, {
      provider: this.name,
      model: this.opts.realtimeModel ?? "scribe_v2_realtime",
      onDone: (sec) => recordTranscription(this.opts.usage, this.price, sec, { streaming: true, model: this.opts.realtimeModel ?? "scribe_v2_realtime", ctx: this.opts.meter }),
      closeTimeoutMs: this.opts.closeTimeoutMs ?? 5000,
    });
  }
}

function normalizeLang(vendor: string | undefined, requested: string): string {
  if (!vendor) return requested;
  // Scribe returns ISO-639-3 ("swe"/"eng"); map the common ones back to the code Forge uses.
  const map: Record<string, string> = { swe: "sv", eng: "en", nor: "no", nob: "no", dan: "da", fin: "fi", deu: "de" };
  return map[vendor.toLowerCase()] ?? vendor.toLowerCase();
}

class ElevenLabsStream extends StreamEmitter implements SttStream {
  private bytes = 0;
  private lastCommitSec = 0;
  private segments: TranscriptSegment[] = [];
  private words: TranscriptWord[] = [];
  private labeler = new SpeakerLabeler();
  private pendingCommit: string | undefined;
  private closing = false;
  private gotFinalAfterClose: (() => void) | undefined;
  private failure: Error | undefined;

  constructor(
    private readonly sock: QueuedSocket,
    private readonly o: StreamOptions,
    private readonly meta: { provider: string; model: string; onDone: (sec: number) => Promise<void>; closeTimeoutMs: number },
  ) {
    super();
    sock.ws.onMessage((d) => this.onMessage(typeof d === "string" ? d : new TextDecoder().decode(d)));
    sock.ws.onError((e) => this.fail(e));
  }

  private get audioSec(): number {
    return pcmDurationSec(this.bytes, this.o.sampleRate, this.o.channels ?? 1);
  }

  private fail(e: Error): void {
    this.failure = e;
    this.emitError(e);
  }

  private pushFinal(text: string, words?: TranscriptWord[]): void {
    const clean = text.trim();
    if (!clean) return;
    const start = words?.[0]?.start ?? this.lastCommitSec;
    const end = words?.length ? (words[words.length - 1]?.end ?? this.audioSec) : this.audioSec;
    const seg: TranscriptSegment = { start, end, text: words?.length ? joinWords(words.map((w) => w.text)) || clean : clean };
    const sp = words?.find((w) => w.speaker)?.speaker;
    if (sp) seg.speaker = sp;
    this.segments.push(seg);
    if (words) this.words.push(...words);
    this.lastCommitSec = end;
    this.emitFinal(seg);
    this.gotFinalAfterClose?.();
  }

  private flushPending(): void {
    if (this.pendingCommit !== undefined) {
      const t = this.pendingCommit;
      this.pendingCommit = undefined;
      this.pushFinal(t);
    }
  }

  private onMessage(raw: string): void {
    let msg: z.infer<typeof RealtimeMsg>;
    try {
      msg = RealtimeMsg.parse(JSON.parse(raw));
    } catch {
      return; // ignore non-JSON keepalives
    }
    switch (msg.message_type) {
      case "session_started":
        return;
      case "partial_transcript":
        this.flushPending();
        if (msg.text) this.emitPartial(msg.text);
        return;
      case "committed_transcript":
        this.flushPending();
        this.pendingCommit = msg.text ?? "";
        if (this.closing) this.flushPending();
        return;
      case "committed_transcript_with_timestamps": {
        this.pendingCommit = undefined;
        this.pushFinal(msg.text ?? "", msg.words ? mapWords(msg.words, this.labeler) : undefined);
        return;
      }
      default:
        if (/error|exceeded|limited|invalid/i.test(msg.message_type)) {
          this.fail(new ForgeError("PROVIDER_ERROR", `elevenlabs realtime ${msg.message_type}: ${msg.error ?? msg.message ?? ""}`));
        }
    }
  }

  send(chunk: Uint8Array): void {
    if (this.closing) throw new ForgeError("BAD_INPUT", "SttStream already closed");
    this.bytes += chunk.byteLength;
    this.sock.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: bytesToBase64(chunk), commit: false, sample_rate: this.o.sampleRate }));
  }

  async close(): Promise<Transcript> {
    this.closing = true;
    this.flushPending();
    const finalSeen = new Promise<void>((resolve) => {
      this.gotFinalAfterClose = resolve;
    });
    // Manual commit of whatever VAD has not committed yet.
    this.sock.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: "", commit: true, sample_rate: this.o.sampleRate }));
    if (this.bytes > 0) await withTimeout(Promise.race([finalSeen, this.sock.closed.then(() => undefined)]), this.meta.closeTimeoutMs);
    // Give a with_timestamps follow-up a moment if only the plain commit arrived.
    this.flushPending();
    this.sock.ws.close(1000, "done");
    const durationSec = this.audioSec;
    await this.meta.onDone(durationSec);
    if (this.failure && this.segments.length === 0) throw this.failure;
    return transcriptFromSegments(this.segments, { language: this.o.language, durationSec, provider: this.meta.provider, model: this.meta.model, words: this.words });
  }
}
