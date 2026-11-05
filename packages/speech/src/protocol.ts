/**
 * Message protocol for streaming microphone audio over the Forge WebSocket gateway (web + mobile).
 * Isomorphic: no Node or DOM APIs; safe to import from `@forge/speech/protocol` in browsers / React Native.
 *
 * client → server: audio.start, audio.chunk (base64 PCM16/opus, ordered by seq), audio.stop
 * server → client: transcript.partial, transcript.final (one committed segment), transcript.done (full transcript),
 *                  transcript.error
 */
import { z } from "zod";
import { bytesToBase64, base64ToBytes } from "./base64.js";
import { floatTo16BitPcm, int16ToBytes, resampleLinear } from "./wav.js";
import { TranscriptSchema, TranscriptSegmentSchema, type Transcript, type TranscriptSegment } from "./types.js";

/** 256 KiB of audio per chunk max (≈ 8 s of 16 kHz PCM16) → base64 length bound. */
export const MAX_CHUNK_BYTES = 256 * 1024;
const MAX_B64 = Math.ceil(MAX_CHUNK_BYTES / 3) * 4;

const streamId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

export const AudioStartSchema = z.object({
  type: z.literal("audio.start"),
  streamId,
  language: z.string().min(2).max(16),
  sampleRate: z.number().int().min(8000).max(48000),
  encoding: z.enum(["pcm16", "opus"]),
  channels: z.number().int().min(1).max(2).optional(),
  diarize: z.boolean().optional(),
});
export const AudioChunkSchema = z.object({
  type: z.literal("audio.chunk"),
  streamId,
  seq: z.number().int().nonnegative(),
  data: z.string().max(MAX_B64),
});
export const AudioStopSchema = z.object({ type: z.literal("audio.stop"), streamId });

export const ClientAudioMessageSchema = z.discriminatedUnion("type", [AudioStartSchema, AudioChunkSchema, AudioStopSchema]);
export type ClientAudioMessage = z.infer<typeof ClientAudioMessageSchema>;
export type AudioStartMessage = z.infer<typeof AudioStartSchema>;

export const ServerTranscriptMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("transcript.partial"), streamId, text: z.string() }),
  z.object({ type: z.literal("transcript.final"), streamId, segment: TranscriptSegmentSchema }),
  z.object({ type: z.literal("transcript.done"), streamId, transcript: TranscriptSchema }),
  z.object({ type: z.literal("transcript.error"), streamId: z.string(), code: z.string(), message: z.string() }),
]);
export type ServerTranscriptMessage = z.infer<typeof ServerTranscriptMessageSchema>;

export function isClientAudioMessage(v: unknown): boolean {
  return typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string" && (v as { type: string }).type.startsWith("audio.");
}

export function encodeAudioChunk(streamIdValue: string, seq: number, bytes: Uint8Array): ClientAudioMessage {
  return { type: "audio.chunk", streamId: streamIdValue, seq, data: bytesToBase64(bytes) };
}

export function decodeAudioChunk(m: Extract<ClientAudioMessage, { type: "audio.chunk" }>): Uint8Array {
  return base64ToBytes(m.data);
}

export interface AudioStreamClientOptions {
  /** Transport: typically `(s) => gatewaySocket.send(s)`. */
  send: (json: string) => void;
  language: string;
  sampleRate?: number;
  encoding?: "pcm16" | "opus";
  diarize?: boolean;
  streamId?: string;
  onPartial?: (text: string) => void;
  onFinal?: (segment: TranscriptSegment) => void;
  onDone?: (t: Transcript) => void;
  onError?: (e: { code: string; message: string }) => void;
}

let counter = 0;

/** Client half (browser / Expo): frames mic audio into protocol messages and dispatches server replies. */
export class AudioStreamClient {
  readonly streamId: string;
  private seq = 0;
  private started = false;
  readonly sampleRate: number;
  constructor(private readonly o: AudioStreamClientOptions) {
    this.streamId = o.streamId ?? `mic_${Date.now().toString(36)}_${(counter++).toString(36)}`;
    this.sampleRate = o.sampleRate ?? 16000;
  }
  private out(m: ClientAudioMessage): void {
    this.o.send(JSON.stringify(m));
  }
  start(): void {
    if (this.started) return;
    this.started = true;
    const m: ClientAudioMessage = { type: "audio.start", streamId: this.streamId, language: this.o.language, sampleRate: this.sampleRate, encoding: this.o.encoding ?? "pcm16" };
    if (this.o.diarize !== undefined) m.diarize = this.o.diarize;
    this.out(m);
  }
  /** Send already-encoded bytes (PCM16 LE or opus packets), split to respect MAX_CHUNK_BYTES. */
  sendBytes(bytes: Uint8Array): void {
    if (!this.started) this.start();
    for (let o = 0; o < bytes.byteLength; o += MAX_CHUNK_BYTES) {
      this.out(encodeAudioChunk(this.streamId, this.seq++, bytes.subarray(o, Math.min(o + MAX_CHUNK_BYTES, bytes.byteLength))));
    }
  }
  sendPcm16(samples: Int16Array): void {
    this.sendBytes(int16ToBytes(samples));
  }
  /** Web Audio / expo-av float frames at `inputRate` → resampled PCM16 at the stream's sample rate. */
  sendFloat32(samples: Float32Array, inputRate: number): void {
    this.sendPcm16(floatTo16BitPcm(resampleLinear(samples, inputRate, this.sampleRate)));
  }
  stop(): void {
    if (!this.started) return;
    this.out({ type: "audio.stop", streamId: this.streamId });
    this.started = false;
  }
  /** Feed every gateway message here; returns true if it belonged to this stream. */
  handleServerMessage(raw: string | unknown): boolean {
    let v: unknown = raw;
    if (typeof raw === "string") {
      try {
        v = JSON.parse(raw);
      } catch {
        return false;
      }
    }
    const p = ServerTranscriptMessageSchema.safeParse(v);
    if (!p.success || p.data.streamId !== this.streamId) return false;
    const m = p.data;
    if (m.type === "transcript.partial") this.o.onPartial?.(m.text);
    else if (m.type === "transcript.final") this.o.onFinal?.(m.segment);
    else if (m.type === "transcript.done") this.o.onDone?.(m.transcript);
    else this.o.onError?.({ code: m.code, message: m.message });
    return true;
  }
}
