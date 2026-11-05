import type { WebSocket } from "ws";
import type { ApiDeps } from "./deps.js";
import type { HttpExtension } from "./server.js";
import type { AudioStreamHandler } from "./ws/gateway.js";
import type { MediaEstimator, SlidesExporter, UploadService, MeetingUrlParser } from "./services.js";

/**
 * Connects domain packages to the API through the ports in services.ts. Each package is imported
 * dynamically so a missing optional native dependency in one package never takes the API down.
 */
export async function wireServices(deps: ApiDeps): Promise<{ extensions: HttpExtension[]; audio?: AudioStreamHandler }> {
  const extensions: HttpExtension[] = [];
  const s = deps.services;

  // ---- media ----
  const media = await import("@forge/media");
  const provider = media.createMediaProvider();
  const toJob = (kind: string, prompt: string, o: Record<string, unknown>) => {
    if (kind === "video") return { type: "text-to-video" as const, prompt, durationSec: Number(o.durationSec ?? 10), aspectRatio: "16:9" as const };
    if (kind === "remotion") return { type: "text-to-video" as const, prompt, durationSec: Number(o.durationSec ?? 20), aspectRatio: "16:9" as const };
    return { type: "text-to-image" as const, prompt, width: Number(o.width ?? 1024), height: Number(o.height ?? 1024), n: kind === "image-set" ? Number(o.n ?? 4) : Number(o.n ?? 1) };
  };
  const estimator: MediaEstimator = {
    async estimate(kind, prompt, options) {
      if (kind === "remotion") return { lowUsd: 0.01, highUsd: 0.05, breakdown: [{ label: "Remotion render (compute only)", usd: 0.03 }] };
      return provider.estimate(media.MediaJobSchema.parse(toJob(kind, prompt, options)));
    },
    async moderate(prompt) {
      const r = await media.moderate({ prompt });
      return { allowed: r.allowed, category: r.category, reason: r.reason };
    },
  };
  s.media = estimator;

  // ---- slides ----
  const slides = await import("@forge/slides");
  const exporter: SlidesExporter = {
    validateDeck(d) {
      try {
        slides.parseDeck(d);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 500) };
      }
    },
    validateDocument(d) {
      try {
        slides.parseDoc(d);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 500) };
      }
    },
    async exportDeck(d, format) {
      const deck = slides.parseDeck(d);
      if (format === "pptx") return { bytes: await slides.exportPptx(deck), mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: "pptx" };
      if (format === "pdf") return { bytes: await slides.exportDeckPdf(deck), mimeType: "application/pdf", ext: "pdf" };
      return { bytes: new TextEncoder().encode(slides.renderDeckHtml(deck)), mimeType: "text/html", ext: "html" };
    },
    async exportDocument(d, format) {
      const doc = slides.parseDoc(d);
      if (format === "docx") return { bytes: await slides.exportDocx(doc), mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx" };
      if (format === "pdf") return { bytes: await slides.exportDocPdf(doc), mimeType: "application/pdf", ext: "pdf" };
      return { bytes: new TextEncoder().encode(slides.renderDocHtml(doc)), mimeType: "text/html", ext: "html" };
    },
  };
  s.slides = exporter;

  // ---- meetings: URL parsing + resumable uploads ----
  const meetings = await import("@forge/meetings");
  const urlParser: MeetingUrlParser = {
    parse(url) {
      try {
        const p = meetings.parseMeetingUrl(url);
        return { platform: p.platform, nativeId: p.nativeId };
      } catch {
        return null;
      }
    },
  };
  s.meetingUrls = urlParser;
  const uploader = new meetings.ChunkedUploadService(deps.store, new meetings.DrizzleChunkRepo(deps.db));
  const uploads: UploadService = {
    async init(o) {
      const r = await uploader.init({ meetingId: o.meetingId, totalSize: o.totalSize, mimeType: o.mimeType, chunkSize: o.chunkSize });
      return { uploadId: r.uploadId };
    },
    async putChunk(id, index, bytes, sha) {
      await uploader.putChunk(id, index, bytes, sha);
      return { received: (await uploader.status(id)).received };
    },
    async status(id) {
      const st = await uploader.status(id);
      return { received: st.received, missing: st.missing, totalChunks: st.totalChunks };
    },
    async complete(id) {
      const r = await uploader.complete(id);
      return { storageKey: r.key, size: r.size };
    },
  };
  s.uploads = uploads;

  // ---- speech: streaming mic transcription over /ws/audio ----
  const speech = await import("@forge/speech");
  const conns = new Map<string, WebSocket>();
  let seq = 0;
  const manager = new speech.StreamingSessionManager({
    provider: speech.createSttProvider(),
    send: (id, msg) => {
      const ws = conns.get(id);
      if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
    },
    logger: deps.log,
  });
  const audio: AudioStreamHandler = {
    handle(ws, { userId, language }) {
      const id = `${userId}:${++seq}`;
      conns.set(id, ws);
      // Clients may send protocol JSON (audio.start / audio.chunk base64 / audio.stop) or raw binary PCM16
      // 16 kHz frames; binary frames are wrapped into protocol messages on an implicit stream.
      let implicit: { streamId: string; seq: number } | null = null;
      // Process messages strictly in order (start → chunks → stop).
      let chain: Promise<void> = Promise.resolve();
      const handle = (m: unknown) => {
        chain = chain.then(() => manager.handle(id, m)).catch(() => undefined);
      };
      ws.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          if (!implicit) {
            implicit = { streamId: `bin${seq}`, seq: 0 };
            handle({ type: "audio.start", streamId: implicit.streamId, language, sampleRate: 16000, encoding: "pcm16" });
          }
          handle({ type: "audio.chunk", streamId: implicit.streamId, seq: implicit.seq++, data: speech.bytesToBase64(new Uint8Array(data)) });
          return;
        }
        const text = data.toString();
        if (implicit && /"type"\s*:\s*"audio\.stop"/.test(text) && !/"streamId"/.test(text)) {
          handle({ type: "audio.stop", streamId: implicit.streamId });
          implicit = null;
          return;
        }
        handle(text);
      });
      ws.on("close", () => {
        chain = chain.then(() => manager.disconnect(id)).finally(() => conns.delete(id));
      });
    },
  };

  return { extensions, audio };
}
