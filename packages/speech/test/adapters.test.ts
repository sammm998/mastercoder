import { describe, it, expect } from "vitest";
import { MemoryUsageSink, ForgeError } from "@forge/shared";
import { ElevenLabsSttProvider } from "../src/adapters/elevenlabs.js";
import { DeepgramSttProvider } from "../src/adapters/deepgram.js";
import { WhisperSttProvider, quietCutPoint } from "../src/adapters/whisper.js";
import { encodeWav, int16ToBytes } from "../src/wav.js";
import { base64ToBytes } from "../src/base64.js";
import { STT_PRICES } from "../src/pricing.js";
import { fakeWsFactory, silence, stubFetch, tick } from "./helpers.js";

const wav10s = encodeWav(silence(10), { sampleRate: 16000 });

describe("ElevenLabsSttProvider", () => {
  const response = {
    language_code: "swe",
    language_probability: 0.98,
    text: "Hej Anna. Hej!",
    words: [
      { text: "Hej", start: 0.1, end: 0.4, type: "word", speaker_id: "speaker_1" },
      { text: " ", start: 0.4, end: 0.5, type: "spacing", speaker_id: "speaker_1" },
      { text: "Anna.", start: 0.5, end: 0.9, type: "word", speaker_id: "speaker_1" },
      { text: "(skratt)", start: 1.0, end: 1.2, type: "audio_event", speaker_id: "speaker_0" },
      { text: "Hej!", start: 1.3, end: 1.6, type: "word", speaker_id: "speaker_0" },
    ],
  };

  it("posts multipart to /v1/speech-to-text and normalizes words, speakers, language", async () => {
    const { fetch, calls } = stubFetch(response);
    const usage = new MemoryUsageSink();
    const p = new ElevenLabsSttProvider({ apiKey: "k-test", fetch, usage, meter: { projectId: "prj_1" } });
    const t = await p.transcribe(wav10s, { mimeType: "audio/wav", language: "sv", diarize: true });
    expect(calls[0]!.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["xi-api-key"]).toBe("k-test");
    const form = calls[0]!.body as FormData;
    expect(form.get("model_id")).toBe("scribe_v1");
    expect(form.get("language_code")).toBe("sv");
    expect(form.get("diarize")).toBe("true");
    expect((form.get("file") as File).type).toBe("audio/wav");
    expect(t.language).toBe("sv");
    expect(t.durationSec).toBeCloseTo(10, 5);
    expect(t.words?.map((w) => w.text)).toEqual(["Hej", "Anna.", "Hej!"]);
    expect(t.segments).toEqual([
      { start: 0.1, end: 0.9, text: "Hej Anna.", speaker: "Speaker 1" },
      { start: 1.3, end: 1.6, text: "Hej!", speaker: "Speaker 2" },
    ]);
    expect(t.provider).toBe("elevenlabs");
    expect(usage.records).toHaveLength(1);
    expect(usage.records[0]).toMatchObject({ kind: "transcription_minutes", provider: "elevenlabs", projectId: "prj_1" });
    expect(usage.records[0]!.quantity).toBeCloseTo(10 / 60, 6);
    expect(usage.records[0]!.costUsd).toBeCloseTo((10 / 60) * (0.4 / 60), 9);
  });

  it("maps HTTP errors to ForgeError without leaking the key", async () => {
    const { fetch } = stubFetch({ detail: "invalid api key" }, 401);
    const p = new ElevenLabsSttProvider({ apiKey: "secret-key", fetch });
    const err = await p.transcribe(wav10s, { mimeType: "audio/wav", language: "sv" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForgeError);
    expect((err as ForgeError).code).toBe("PROVIDER_ERROR");
    expect((err as Error).message).not.toContain("secret-key");
  });

  it("streams PCM over the realtime WebSocket and commits on close", async () => {
    const { factory, sockets } = fakeWsFactory();
    const usage = new MemoryUsageSink();
    const p = new ElevenLabsSttProvider({ apiKey: "k", wsFactory: factory, usage });
    const s = await p.openStream({ language: "sv", sampleRate: 16000, encoding: "pcm16" });
    const ws = sockets[0]!;
    expect(ws.url).toContain("wss://api.elevenlabs.io/v1/speech-to-text/realtime?");
    expect(ws.url).toContain("audio_format=pcm_16000");
    expect(ws.url).toContain("language_code=sv");
    expect(ws.headers["xi-api-key"]).toBe("k");
    const partials: string[] = [];
    const finals: string[] = [];
    s.on("partial", (e) => partials.push(e.text));
    s.on("final", (e) => finals.push(e.text));
    s.send(silence(1)); // queued until open
    ws.open();
    expect(ws.jsonSent()[0]).toMatchObject({ message_type: "input_audio_chunk", commit: false, sample_rate: 16000 });
    expect(base64ToBytes(ws.jsonSent()[0]!.audio_base_64 as string).byteLength).toBe(32000);
    ws.receive({ message_type: "session_started", session_id: "x" });
    ws.receive({ message_type: "partial_transcript", text: "hej" });
    ws.receive({ message_type: "committed_transcript", text: "Hej allihop." });
    ws.receive({ message_type: "committed_transcript_with_timestamps", text: "Hej allihop.", words: [{ text: "Hej", start: 0, end: 0.3, type: "word" }, { text: "allihop.", start: 0.35, end: 0.9, type: "word" }] });
    s.send(silence(1));
    ws.onClientSend = (m) => {
      const msg = JSON.parse(m as string) as { commit: boolean };
      if (msg.commit) ws.receive({ message_type: "committed_transcript", text: "Vi börjar." });
    };
    const t = await s.close();
    expect(partials).toEqual(["hej"]);
    expect(finals).toEqual(["Hej allihop.", "Vi börjar."]);
    expect(t.text).toBe("Hej allihop. Vi börjar.");
    expect(t.segments[0]).toMatchObject({ start: 0, end: 0.9 });
    expect(t.segments[1]).toMatchObject({ start: 0.9, end: 2 });
    expect(t.durationSec).toBe(2);
    expect(ws.closedByClient).toBeDefined();
    expect(usage.records[0]!.costUsd).toBeCloseTo((2 / 60) * STT_PRICES.elevenlabs.streamingUsdPerMin, 9);
  });

  it("rejects opus for realtime", async () => {
    const p = new ElevenLabsSttProvider({ apiKey: "k", wsFactory: fakeWsFactory().factory });
    await expect(p.openStream({ language: "sv", sampleRate: 48000, encoding: "opus" })).rejects.toThrow(/pcm16/);
  });
});

describe("DeepgramSttProvider", () => {
  const response = {
    metadata: { duration: 12.5, request_id: "r1" },
    results: {
      channels: [
        {
          alternatives: [
            {
              transcript: "hej vi behöver en bokning",
              words: [
                { word: "hej", punctuated_word: "Hej,", start: 0.2, end: 0.5, speaker: 0 },
                { word: "vi", punctuated_word: "vi", start: 1.0, end: 1.2, speaker: 1 },
                { word: "behöver", punctuated_word: "behöver", start: 1.2, end: 1.6, speaker: 1 },
              ],
            },
          ],
        },
      ],
      utterances: [
        { start: 0.2, end: 0.5, transcript: "Hej,", speaker: 0 },
        { start: 1.0, end: 2.4, transcript: "vi behöver en bokning.", speaker: 1 },
      ],
    },
  };

  it("posts raw audio to /v1/listen with nova-3 + language + diarize", async () => {
    const { fetch, calls } = stubFetch(response);
    const usage = new MemoryUsageSink();
    const p = new DeepgramSttProvider({ apiKey: "dg", fetch, usage });
    const t = await p.transcribe(wav10s, { mimeType: "audio/wav", language: "sv", diarize: true });
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://api.deepgram.com/v1/listen");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ model: "nova-3", language: "sv", diarize: "true", smart_format: "true" });
    expect(calls[0]!.headers.authorization).toBe("Token dg");
    expect(calls[0]!.headers["content-type"]).toBe("audio/wav");
    expect((calls[0]!.body as Uint8Array).byteLength).toBe(wav10s.byteLength);
    expect(t.durationSec).toBe(12.5);
    expect(t.segments.map((s) => s.speaker)).toEqual(["Speaker 1", "Speaker 2"]);
    expect(t.words?.[0]).toEqual({ text: "Hej,", start: 0.2, end: 0.5, speaker: "Speaker 1" });
    // nova-3 prerecorded + diarization add-on
    expect(usage.records[0]!.costUsd).toBeCloseTo((12.5 / 60) * (0.0043 + 0.002), 9);
  });

  it("omits speakers when diarize is off", async () => {
    const { fetch, calls } = stubFetch(response);
    const t = await new DeepgramSttProvider({ apiKey: "dg", fetch }).transcribe(wav10s, { mimeType: "audio/wav", language: "sv" });
    expect(new URL(calls[0]!.url).searchParams.has("diarize")).toBe(false);
    expect(t.segments.every((s) => s.speaker === undefined)).toBe(true);
  });

  it("streams binary audio, emits interim/final and flushes on CloseStream", async () => {
    const { factory, sockets } = fakeWsFactory();
    const p = new DeepgramSttProvider({ apiKey: "dg", wsFactory: factory });
    const s = await p.openStream({ language: "sv", sampleRate: 16000, encoding: "pcm16" });
    const ws = sockets[0]!;
    const q = new URL(ws.url).searchParams;
    expect(ws.url.startsWith("wss://api.deepgram.com/v1/listen?")).toBe(true);
    expect(Object.fromEntries(q)).toMatchObject({ model: "nova-3", encoding: "linear16", sample_rate: "16000", interim_results: "true", language: "sv" });
    expect(ws.headers.Authorization).toBe("Token dg");
    const events: string[] = [];
    s.on("partial", (e) => events.push(`p:${e.text}`));
    s.on("final", (e) => events.push(`f:${e.text}@${e.start}`));
    ws.open();
    s.send(int16ToBytes(new Int16Array(16000)));
    expect(ws.sent[0]).toBeInstanceOf(Uint8Array);
    ws.receive({ type: "Results", is_final: false, start: 0, duration: 1, channel: { alternatives: [{ transcript: "hej", words: [] }] } });
    ws.receive({ type: "Results", is_final: true, start: 0, duration: 1, channel: { alternatives: [{ transcript: "Hej på dig.", words: [{ word: "hej", punctuated_word: "Hej", start: 0.1, end: 0.3 }, { word: "dig", punctuated_word: "dig.", start: 0.5, end: 0.8 }] }] } });
    ws.onClientSend = (m) => {
      if (typeof m === "string" && JSON.parse(m).type === "CloseStream") {
        ws.receive({ type: "Results", is_final: true, start: 1, duration: 0.5, channel: { alternatives: [{ transcript: "Klart.", words: [] }] } });
        ws.receive({ type: "Metadata", duration: 1.5 });
        setTimeout(() => ws.serverClose(1000), 0);
      }
    };
    const t = await s.close();
    expect(events).toEqual(["p:hej", "f:Hej på dig.@0.1", "f:Klart.@1"]);
    expect(t.text).toBe("Hej på dig. Klart.");
    expect(t.durationSec).toBe(1);
  });

  it("uses Deepgram's reported duration for opus streams", async () => {
    const { factory, sockets } = fakeWsFactory();
    const usage = new MemoryUsageSink();
    const s = await new DeepgramSttProvider({ apiKey: "dg", wsFactory: factory, usage }).openStream({ language: "en", sampleRate: 48000, encoding: "opus" });
    const ws = sockets[0]!;
    expect(new URL(ws.url).searchParams.get("encoding")).toBe("opus");
    ws.open();
    s.send(new Uint8Array([1, 2, 3]));
    ws.receive({ type: "Results", is_final: true, start: 0, duration: 3, channel: { alternatives: [{ transcript: "hello", words: [] }] } });
    ws.onClientSend = () => setTimeout(() => ws.serverClose(1000), 0);
    const t = await s.close();
    expect(t.durationSec).toBe(3);
    expect(usage.records[0]!.costUsd).toBeCloseTo((3 / 60) * 0.0077, 9);
  });
});

describe("WhisperSttProvider", () => {
  it("posts OpenAI-compatible multipart with verbose_json", async () => {
    const { fetch, calls } = stubFetch({
      text: " Bygg en att-göra-app.",
      language: "swedish",
      duration: 3.6,
      segments: [{ id: 0, start: 0, end: 3.6, text: " Bygg en att-göra-app." }],
      words: [{ word: " Bygg", start: 0, end: 0.4 }, { word: " en", start: 0.4, end: 0.5 }],
    });
    const usage = new MemoryUsageSink();
    const p = new WhisperSttProvider({ baseUrl: "http://whisper.internal:9010/v1/", fetch, usage, apiKey: "w" });
    const t = await p.transcribe(wav10s, { mimeType: "audio/wav", language: "sv", diarize: true });
    expect(calls[0]!.url).toBe("http://whisper.internal:9010/v1/audio/transcriptions");
    expect(calls[0]!.headers.authorization).toBe("Bearer w");
    const form = calls[0]!.body as FormData;
    expect(form.get("model")).toBe("KBLab/kb-whisper-large");
    expect(form.get("language")).toBe("sv");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.getAll("timestamp_granularities[]")).toEqual(["segment", "word"]);
    expect(t).toMatchObject({ text: "Bygg en att-göra-app.", language: "sv", durationSec: 3.6, provider: "whisper" });
    expect(t.segments).toEqual([{ start: 0, end: 3.6, text: "Bygg en att-göra-app." }]);
    expect(t.words?.[0]).toEqual({ text: "Bygg", start: 0, end: 0.4 });
    expect(usage.records[0]!.costUsd).toBeCloseTo((3.6 / 60) * (0.27 / 60 / 10), 12);
  });

  it("emulates streaming with windows and absolute timestamps", async () => {
    let n = 0;
    const calls: number[] = [];
    const fetch = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      const file = (init?.body as FormData).get("file") as File;
      calls.push(file.size);
      n++;
      return new Response(JSON.stringify({ text: `del ${n}`, segments: [{ start: 0.1, end: 0.6, text: `del ${n}` }] }));
    }) as typeof globalThis.fetch;
    const p = new WhisperSttProvider({ baseUrl: "http://w", fetch, windowSec: 1 });
    const s = await p.openStream({ language: "sv", sampleRate: 16000, encoding: "pcm16" });
    const finals: Array<{ text: string; start: number }> = [];
    s.on("final", (f) => finals.push({ text: f.text, start: f.start }));
    for (let i = 0; i < 25; i++) s.send(silence(0.1)); // 2.5 s in 100 ms chunks
    const t = await s.close();
    expect(calls.length).toBe(3);
    expect(finals.map((f) => f.text)).toEqual(["del 1", "del 2", "del 3"]);
    expect(finals[0]!.start).toBeCloseTo(0.1, 3);
    expect(finals[1]!.start).toBeGreaterThan(1);
    expect(finals[2]!.start).toBeGreaterThan(2);
    expect(t.durationSec).toBeCloseTo(2.5, 6);
    expect(t.text).toBe("del 1 del 2 del 3");
  });

  it("cuts windows at the quietest frame", () => {
    const pcm = new Int16Array(16000).fill(5000);
    pcm.fill(0, 12000, 12800); // quiet 50 ms at 0.75-0.8 s
    const at = quietCutPoint(int16ToBytes(pcm), 16000, 1, 0.5);
    expect(at / 2).toBeGreaterThanOrEqual(12000);
    expect(at / 2).toBeLessThanOrEqual(12800);
  });

  it("requires WHISPER_URL and rejects opus streaming", async () => {
    expect(() => new WhisperSttProvider({ baseUrl: "" })).toThrow(/WHISPER_URL/);
    await expect(new WhisperSttProvider({ baseUrl: "http://w" }).openStream({ language: "sv", sampleRate: 48000, encoding: "opus" })).rejects.toThrow();
    await tick();
  });
});
