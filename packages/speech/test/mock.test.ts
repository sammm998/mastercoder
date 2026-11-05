import { describe, it, expect, afterEach } from "vitest";
import { MemoryUsageSink } from "@forge/shared";
import { MockSttProvider, MockTranscriptRegistry, parseLabelledText, sha256Hex } from "../src/mock.js";
import { createSttProvider } from "../src/factory.js";
import { ElevenLabsSttProvider } from "../src/adapters/elevenlabs.js";
import { DeepgramSttProvider } from "../src/adapters/deepgram.js";
import { WhisperSttProvider } from "../src/adapters/whisper.js";
import { chunkPcm, encodeWav } from "../src/wav.js";
import { normalizeSpeakers, segmentsFromWords, transcriptToLabeledText } from "../src/diarization.js";
import { silence } from "./helpers.js";

describe("MockSttProvider", () => {
  it("labels unregistered audio as mock with the real WAV duration", async () => {
    const usage = new MemoryUsageSink();
    const p = new MockSttProvider({ registry: new MockTranscriptRegistry(), usage });
    const t = await p.transcribe(encodeWav(silence(2.5), { sampleRate: 16000 }), { mimeType: "audio/wav", language: "sv" });
    expect(t.text).toBe("[mock transcript: 2.5 s of audio]");
    expect(t.durationSec).toBeCloseTo(2.5, 6);
    expect(t.provider).toBe("mock");
    expect(p.isMock).toBe(true);
    expect(usage.records[0]).toMatchObject({ kind: "transcription_minutes", costUsd: 0, provider: "mock" });
    expect(usage.records[0]!.quantity).toBeCloseTo(2.5 / 60, 6);
  });

  it("labels non-WAV input", async () => {
    const t = await new MockSttProvider({ registry: new MockTranscriptRegistry() }).transcribe(new Uint8Array([1, 2, 3, 4]), { mimeType: "audio/webm", language: "en" });
    expect(t.text).toBe("[mock transcript: non-WAV audio, 4 bytes]");
  });

  it("returns the registered transcript for a known sha256, with diarized speakers", async () => {
    const reg = new MockTranscriptRegistry();
    const wav = encodeWav(silence(4), { sampleRate: 16000 });
    reg.register(sha256Hex(wav), { text: "Anna: Hej och välkommen.\nErik: Tack, vi kör.", language: "sv" });
    const p = new MockSttProvider({ registry: reg });
    const t = await p.transcribe(wav, { mimeType: "audio/wav", language: "sv", diarize: true });
    expect(t.text).toBe("Hej och välkommen. Tack, vi kör.");
    expect(t.segments.map((s) => s.speaker)).toEqual(["Anna", "Erik"]);
    expect(t.segments[1]!.end).toBeCloseTo(4, 3);
    expect(t.words?.length).toBe(6);
    const nd = await p.transcribe(wav, { mimeType: "audio/wav", language: "sv" });
    expect(nd.segments.every((s) => !s.speaker)).toBe(true);
  });

  it("streams: partials per second, transcript matched by the PCM's WAV sha", async () => {
    const reg = new MockTranscriptRegistry();
    const pcm = silence(3);
    reg.registerAudio(encodeWav(pcm, { sampleRate: 16000 }), "Bygg en app.");
    const s = await new MockSttProvider({ registry: reg }).openStream({ language: "sv", sampleRate: 16000, encoding: "pcm16" });
    const partials: string[] = [];
    const finals: string[] = [];
    s.on("partial", (e) => partials.push(e.text));
    s.on("final", (e) => finals.push(e.text));
    for (const c of chunkPcm(pcm, { sampleRate: 16000, chunkMs: 250 })) s.send(c);
    const t = await s.close();
    expect(partials).toEqual(["[mock partial: 1.0 s received]", "[mock partial: 2.0 s received]", "[mock partial: 3.0 s received]"]);
    expect(finals).toEqual(["Bygg en app."]);
    expect(t.durationSec).toBeCloseTo(3, 6);
    expect(() => s.send(new Uint8Array(2))).toThrow();
  });

  it("parses labelled text only when every line is labelled", () => {
    expect(parseLabelledText("A: hej\nB: då")).toEqual([{ speaker: "A", text: "hej" }, { speaker: "B", text: "då" }]);
    expect(parseLabelledText("Kl. 10: möte\nsen lunch")).toEqual([{ text: "Kl. 10: möte sen lunch" }]);
  });
});

describe("createSttProvider", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  it("selects by STT_PROVIDER, falling back to mock", () => {
    delete process.env.STT_PROVIDER;
    expect(createSttProvider()).toBeInstanceOf(MockSttProvider);
    process.env.STT_PROVIDER = "elevenlabs";
    process.env.ELEVENLABS_API_KEY = "x";
    expect(createSttProvider()).toBeInstanceOf(ElevenLabsSttProvider);
    process.env.STT_PROVIDER = "deepgram";
    process.env.DEEPGRAM_API_KEY = "x";
    expect(createSttProvider()).toBeInstanceOf(DeepgramSttProvider);
    process.env.STT_PROVIDER = "whisper";
    process.env.WHISPER_URL = "http://localhost:9010";
    expect(createSttProvider().model).toBe("KBLab/kb-whisper-large");
    expect(createSttProvider()).toBeInstanceOf(WhisperSttProvider);
    process.env.STT_PROVIDER = "nope";
    expect(() => createSttProvider()).toThrow(/Unknown STT_PROVIDER/);
  });
  it("throws when a real adapter's key is missing", () => {
    process.env.STT_PROVIDER = "deepgram";
    delete process.env.DEEPGRAM_API_KEY;
    expect(() => createSttProvider()).toThrow(/DEEPGRAM_API_KEY/);
  });
  it("estimates cost from the price table", () => {
    process.env.STT_PROVIDER = "deepgram";
    process.env.DEEPGRAM_API_KEY = "x";
    const e = createSttProvider().estimate(600);
    expect(e.breakdown[0]!.usd).toBeCloseTo(10 * 0.0043, 6);
    expect(e.lowUsd).toBeLessThan(e.highUsd);
  });
});

describe("diarization helpers", () => {
  it("normalizes vendor speaker ids in order of appearance", () => {
    const t = normalizeSpeakers({
      text: "",
      language: "sv",
      durationSec: 2,
      provider: "x",
      model: "y",
      segments: [{ start: 0, end: 1, text: "a", speaker: "SPEAKER_07" }, { start: 1, end: 2, text: "b", speaker: "SPEAKER_02" }, { start: 2, end: 3, text: "c" }],
    });
    expect(t.segments.map((s) => s.speaker)).toEqual(["Speaker 1", "Speaker 2", undefined]);
    expect("speaker" in (t.segments[2] as object)).toBe(false);
    expect(transcriptToLabeledText(t)).toBe("Speaker 1: a\nSpeaker 2: b\nc");
  });
  it("groups words by speaker and pauses", () => {
    const segs = segmentsFromWords([
      { text: "Hej", start: 0, end: 0.3, speaker: "A" },
      { text: "där", start: 0.3, end: 0.6, speaker: "A" },
      { text: ".", start: 0.6, end: 0.6, speaker: "A" },
      { text: "Ja", start: 0.8, end: 1, speaker: "B" },
      { text: "precis", start: 3, end: 3.4, speaker: "B" },
    ]);
    expect(segs.map((s) => [s.text, s.speaker])).toEqual([["Hej där.", "A"], ["Ja", "B"], ["precis", "B"]]);
  });
});
