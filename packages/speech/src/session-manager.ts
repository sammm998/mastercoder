import { createLogger, isForgeError, type Logger } from "@forge/shared";
import type { SttProvider, SttStream, Transcript } from "./types.js";
import { ClientAudioMessageSchema, decodeAudioChunk, type ServerTranscriptMessage } from "./protocol.js";

export interface StreamingSessionManagerOptions {
  provider: SttProvider;
  /** Deliver a server message to one gateway connection. */
  send: (connectionId: string, msg: ServerTranscriptMessage) => void;
  /** Called with the finished transcript of each stream (persist / feed the intent router). */
  onTranscript?: (connectionId: string, streamId: string, t: Transcript) => void | Promise<void>;
  maxStreamsPerConnection?: number;
  /** Hard cap on audio bytes per stream (default ≈ 1 h of 16 kHz PCM16). */
  maxBytesPerStream?: number;
  logger?: Logger;
}

interface Session {
  stream: SttStream;
  nextSeq: number;
  bytes: number;
  stopping: boolean;
}

/**
 * Server-side bridge between gateway WebSocket messages (`audio.*`) and an SttStream.
 * One instance per process; sessions are keyed by (connectionId, streamId).
 */
export class StreamingSessionManager {
  private sessions = new Map<string, Session>();
  private readonly log: Logger;
  constructor(private readonly o: StreamingSessionManagerOptions) {
    this.log = o.logger ?? createLogger({ component: "speech.session-manager" });
  }

  private key(connectionId: string, streamId: string): string {
    return `${connectionId}\u0000${streamId}`;
  }

  get activeStreams(): number {
    return this.sessions.size;
  }

  private countFor(connectionId: string): number {
    let n = 0;
    for (const k of this.sessions.keys()) if (k.startsWith(`${connectionId}\u0000`)) n++;
    return n;
  }

  private error(connectionId: string, streamId: string, code: string, message: string): void {
    this.o.send(connectionId, { type: "transcript.error", streamId, code, message });
  }

  /** Handle one inbound gateway message (string JSON or parsed object). Never throws on bad client input. */
  async handle(connectionId: string, raw: unknown): Promise<void> {
    let v = raw;
    if (typeof raw === "string") {
      try {
        v = JSON.parse(raw);
      } catch {
        return this.error(connectionId, "", "BAD_INPUT", "Message is not JSON");
      }
    }
    const parsed = ClientAudioMessageSchema.safeParse(v);
    if (!parsed.success) {
      const sid = typeof (v as { streamId?: unknown })?.streamId === "string" ? (v as { streamId: string }).streamId : "";
      return this.error(connectionId, sid, "BAD_INPUT", parsed.error.issues.map((i) => i.message).join("; "));
    }
    const m = parsed.data;
    const k = this.key(connectionId, m.streamId);
    if (m.type === "audio.start") {
      if (this.sessions.has(k)) return this.error(connectionId, m.streamId, "BAD_INPUT", "Stream already started");
      if (this.countFor(connectionId) >= (this.o.maxStreamsPerConnection ?? 2)) {
        return this.error(connectionId, m.streamId, "RATE_LIMITED", "Too many concurrent audio streams on this connection");
      }
      let stream: SttStream;
      try {
        stream = await this.o.provider.openStream({ language: m.language, sampleRate: m.sampleRate, encoding: m.encoding, channels: m.channels, diarize: m.diarize });
      } catch (e) {
        return this.error(connectionId, m.streamId, isForgeError(e) ? e.code : "PROVIDER_ERROR", (e as Error).message);
      }
      stream.on("partial", (p) => this.o.send(connectionId, { type: "transcript.partial", streamId: m.streamId, text: p.text }));
      stream.on("final", (segment) => this.o.send(connectionId, { type: "transcript.final", streamId: m.streamId, segment }));
      stream.on("error", (e) => this.error(connectionId, m.streamId, isForgeError(e) ? e.code : "PROVIDER_ERROR", e.message));
      this.sessions.set(k, { stream, nextSeq: 0, bytes: 0, stopping: false });
      return;
    }
    const s = this.sessions.get(k);
    if (!s) return this.error(connectionId, m.streamId, "NOT_FOUND", "Unknown stream (send audio.start first)");
    if (m.type === "audio.chunk") {
      if (s.stopping) return;
      if (m.seq < s.nextSeq) return; // duplicate / replayed chunk
      let bytes: Uint8Array;
      try {
        bytes = decodeAudioChunk(m);
      } catch {
        return this.error(connectionId, m.streamId, "BAD_INPUT", "Invalid base64 audio");
      }
      s.nextSeq = m.seq + 1;
      s.bytes += bytes.byteLength;
      if (s.bytes > (this.o.maxBytesPerStream ?? 16000 * 2 * 3600)) {
        this.error(connectionId, m.streamId, "BAD_INPUT", "Audio stream exceeds the maximum length; stopping");
        return this.stop(connectionId, m.streamId);
      }
      try {
        s.stream.send(bytes);
      } catch (e) {
        this.error(connectionId, m.streamId, "PROVIDER_ERROR", (e as Error).message);
      }
      return;
    }
    return this.stop(connectionId, m.streamId);
  }

  private async stop(connectionId: string, streamId: string): Promise<void> {
    const k = this.key(connectionId, streamId);
    const s = this.sessions.get(k);
    if (!s || s.stopping) return;
    s.stopping = true;
    try {
      const t = await s.stream.close();
      this.o.send(connectionId, { type: "transcript.done", streamId, transcript: t });
      await this.o.onTranscript?.(connectionId, streamId, t);
    } catch (e) {
      this.log.warn("stream close failed", { streamId, error: (e as Error).message });
      this.error(connectionId, streamId, isForgeError(e) ? e.code : "PROVIDER_ERROR", (e as Error).message);
    } finally {
      this.sessions.delete(k);
    }
  }

  /** Gateway connection closed: finish every stream it owned (transcripts still reach onTranscript). */
  async disconnect(connectionId: string): Promise<void> {
    const ids = [...this.sessions.keys()].filter((k) => k.startsWith(`${connectionId}\u0000`)).map((k) => k.split("\u0000")[1] as string);
    await Promise.all(ids.map((id) => this.stop(connectionId, id)));
  }
}
