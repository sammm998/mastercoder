import { z } from "zod";
import type { CostEstimate } from "@forge/shared";

export const TranscriptWordSchema = z.object({
  text: z.string(),
  start: z.number(),
  end: z.number(),
  speaker: z.string().optional(),
});
export type TranscriptWord = z.infer<typeof TranscriptWordSchema>;

export const TranscriptSegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
  speaker: z.string().optional(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

export const TranscriptSchema = z.object({
  text: z.string(),
  language: z.string(),
  durationSec: z.number().nonnegative(),
  segments: z.array(TranscriptSegmentSchema),
  words: z.array(TranscriptWordSchema).optional(),
  provider: z.string(),
  model: z.string(),
});
export type Transcript = z.infer<typeof TranscriptSchema>;

/** "sv" | "en" are first-class; any BCP-47/ISO-639 code accepted by the vendor works. */
export type SpeechLanguage = "sv" | "en" | (string & {});

export interface TranscribeOptions {
  /** e.g. "audio/wav", "audio/webm", "audio/ogg", "audio/mpeg". */
  mimeType: string;
  language: SpeechLanguage;
  diarize?: boolean;
  /** Optional abort signal for the HTTP request. */
  signal?: AbortSignal;
}

export type StreamEncoding = "pcm16" | "opus";

export interface StreamOptions {
  language: SpeechLanguage;
  sampleRate: number;
  encoding: StreamEncoding;
  /** Mono only for pcm16; default 1. */
  channels?: number;
  diarize?: boolean;
}

export interface PartialEvent {
  text: string;
}

export interface SttStreamEvents {
  partial: (e: PartialEvent) => void;
  final: (segment: TranscriptSegment) => void;
  error: (err: Error) => void;
}

export interface SttStream {
  send(chunk: Uint8Array): void;
  on<K extends keyof SttStreamEvents>(event: K, cb: SttStreamEvents[K]): void;
  /** Flush, wait for the last final results and return the complete transcript. */
  close(): Promise<Transcript>;
}

export interface SttProvider {
  readonly name: string;
  readonly isMock: boolean;
  readonly model: string;
  transcribe(audio: Uint8Array, opts: TranscribeOptions): Promise<Transcript>;
  openStream(opts: StreamOptions): Promise<SttStream>;
  /** Provider cost estimate for `durationSec` of audio (prerecorded unless `streaming`). */
  estimate(durationSec: number, opts?: { streaming?: boolean; diarize?: boolean }): CostEstimate;
}

/** Metering context attached to every UsageRecord a provider writes. */
export interface MeterContext {
  workspaceId?: string;
  projectId?: string;
  taskId?: string;
  agentId?: string;
}
