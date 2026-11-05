import { describe, expect, it } from "vitest";
import {
  AudioStreamSession,
  STOP_MESSAGE,
  emptyTranscript,
  float32ToInt16,
  parseAudioServerMessage,
  peakLevel,
  reduceTranscript,
  startMessage,
  transcriptText,
} from "../src/lib/audio-protocol.js";

describe("audio server messages", () => {
  it("parses transcript variants leniently", () => {
    expect(parseAudioServerMessage('{"type":"transcript","text":"hej","isFinal":false}')).toEqual({ type: "transcript", text: "hej", isFinal: false });
    expect(parseAudioServerMessage('{"type":"transcript","transcript":"hej","is_final":true}')).toEqual({ type: "transcript", text: "hej", isFinal: true });
    expect(parseAudioServerMessage('{"type":"partial","text":"he"}')).toEqual({ type: "transcript", text: "he", isFinal: false });
    expect(parseAudioServerMessage('{"type":"final","text":"hej då"}')).toEqual({ type: "transcript", text: "hej då", isFinal: true });
    expect(parseAudioServerMessage('{"type":"error","message":"quota"}')).toEqual({ type: "error", message: "quota" });
    expect(parseAudioServerMessage('{"type":"done"}')).toEqual({ type: "done" });
    expect(parseAudioServerMessage("garbage")).toBeNull();
    expect(parseAudioServerMessage('{"type":"transcript"}')).toBeNull();
  });

  it("builds the transcript from finals plus the live partial", () => {
    let s = emptyTranscript;
    s = reduceTranscript(s, { type: "transcript", text: "Bygg en", isFinal: false });
    expect(transcriptText(s)).toBe("Bygg en");
    s = reduceTranscript(s, { type: "transcript", text: "Bygg en app", isFinal: true });
    s = reduceTranscript(s, { type: "transcript", text: " för  bokningar", isFinal: false });
    expect(transcriptText(s)).toBe("Bygg en app för bokningar");
    s = reduceTranscript(s, { type: "error", message: "x" });
    expect(transcriptText(s)).toBe("Bygg en app för bokningar");
  });
});

describe("PCM helpers", () => {
  it("converts float32 to little-endian int16 with clipping", () => {
    const out = new DataView(float32ToInt16(new Float32Array([0, 1, -1, 2])));
    expect(out.getInt16(0, true)).toBe(0);
    expect(out.getInt16(2, true)).toBe(32767);
    expect(out.getInt16(4, true)).toBe(-32768);
    expect(out.getInt16(6, true)).toBe(32767);
  });
  it("computes a peak level", () => {
    expect(peakLevel(new Int16Array([0, -16384, 100]).buffer)).toBeCloseTo(0.5, 2);
    expect(peakLevel(new ArrayBuffer(0))).toBe(0);
  });
});

describe("AudioStreamSession", () => {
  function sink() {
    const sent: Array<string | ArrayBuffer> = [];
    let open = false;
    return { sent, setOpen: (v: boolean) => (open = v), sink: { isOpen: () => open, send: (d: string | ArrayBuffer) => sent.push(d) } };
  }
  const fmt = { sampleRate: 16000, channels: 1 };

  it("queues audio until the socket opens, then sends start with the real format first", () => {
    const s = sink();
    const sess = new AudioStreamSession(s.sink, "sv");
    sess.push(new ArrayBuffer(320), { sampleRate: 15999.6, channels: 1 });
    sess.push(new ArrayBuffer(320), fmt);
    expect(s.sent).toHaveLength(0);
    s.setOpen(true);
    sess.flush();
    expect(s.sent[0]).toBe(startMessage({ sampleRate: 16000, channels: 1 }, "sv"));
    expect(JSON.parse(s.sent[0] as string)).toEqual({ type: "start", encoding: "pcm_s16le", sampleRate: 16000, channels: 1, language: "sv" });
    expect(s.sent.slice(1).every((x) => x instanceof ArrayBuffer)).toBe(true);
    expect(sess.sentBytes).toBe(640);
  });

  it("bounds the queue while disconnected", () => {
    const s = sink();
    const sess = new AudioStreamSession(s.sink, "en", 1000);
    for (let i = 0; i < 10; i++) sess.push(new ArrayBuffer(300), fmt);
    expect(sess.dropped).toBeGreaterThan(0);
    s.setOpen(true);
    sess.flush();
    expect(sess.sentBytes).toBeLessThanOrEqual(1000);
  });

  it("sends stop exactly once and ignores audio afterwards", () => {
    const s = sink();
    s.setOpen(true);
    const sess = new AudioStreamSession(s.sink, "en");
    sess.push(new ArrayBuffer(10), fmt);
    sess.stop();
    sess.stop();
    sess.push(new ArrayBuffer(10), fmt);
    expect(s.sent.filter((x) => x === STOP_MESSAGE)).toHaveLength(1);
    expect(s.sent.at(-1)).toBe(STOP_MESSAGE);
  });
});
