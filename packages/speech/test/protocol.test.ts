import { describe, it, expect } from "vitest";
import { AudioStreamClient, ServerTranscriptMessageSchema, type ServerTranscriptMessage } from "../src/protocol.js";
import { StreamingSessionManager } from "../src/session-manager.js";
import { MockSttProvider, MockTranscriptRegistry } from "../src/mock.js";
import { encodeWav, int16ToBytes } from "../src/wav.js";
import { silence } from "./helpers.js";
import type { Transcript } from "../src/types.js";

function setup(registry = new MockTranscriptRegistry()) {
  const toClient: Array<{ conn: string; msg: ServerTranscriptMessage }> = [];
  const done: Array<{ conn: string; streamId: string; t: Transcript }> = [];
  const mgr = new StreamingSessionManager({
    provider: new MockSttProvider({ registry }),
    send: (conn, msg) => toClient.push({ conn, msg }),
    onTranscript: (conn, streamId, t) => void done.push({ conn, streamId, t }),
    maxStreamsPerConnection: 1,
    maxBytesPerStream: 16000 * 2 * 5,
  });
  return { mgr, toClient, done };
}

describe("AudioStreamClient + StreamingSessionManager", () => {
  it("bridges a full mic session end to end (client → gateway → SttStream → client)", async () => {
    const registry = new MockTranscriptRegistry();
    const pcm = silence(2);
    registry.registerAudio(encodeWav(pcm, { sampleRate: 16000 }), "Bygg en att-göra-app.");
    const { mgr, toClient, done } = setup(registry);
    const wire: string[] = [];
    const got: { partial: string[]; final: string[]; done?: Transcript } = { partial: [], final: [] };
    const client = new AudioStreamClient({
      send: (s) => wire.push(s),
      language: "sv",
      streamId: "s1",
      onPartial: (t) => got.partial.push(t),
      onFinal: (s) => got.final.push(s.text),
      onDone: (t) => (got.done = t),
    });
    client.start();
    const samples = new Int16Array(pcm.byteLength / 2);
    client.sendPcm16(samples.subarray(0, 16000));
    client.sendPcm16(samples.subarray(16000));
    client.stop();
    expect(wire.map((w) => JSON.parse(w).type)).toEqual(["audio.start", "audio.chunk", "audio.chunk", "audio.stop"]);
    for (const w of wire) await mgr.handle("conn1", w);
    // Dispatch server messages back to the client.
    for (const { msg } of toClient) expect(client.handleServerMessage(JSON.stringify(msg))).toBe(true);
    expect(got.partial).toEqual(["[mock partial: 1.0 s received]", "[mock partial: 2.0 s received]"]);
    expect(got.final).toEqual(["Bygg en att-göra-app."]);
    expect(got.done?.text).toBe("Bygg en att-göra-app.");
    expect(done[0]).toMatchObject({ conn: "conn1", streamId: "s1" });
    expect(mgr.activeStreams).toBe(0);
    for (const { msg } of toClient) expect(ServerTranscriptMessageSchema.safeParse(msg).success).toBe(true);
  });

  it("ignores messages for other streams and invalid JSON on the client", () => {
    const c = new AudioStreamClient({ send: () => undefined, language: "sv", streamId: "a" });
    expect(c.handleServerMessage({ type: "transcript.partial", streamId: "b", text: "x" })).toBe(false);
    expect(c.handleServerMessage("{nope")).toBe(false);
  });

  it("resamples float mic frames to 16 kHz PCM16", () => {
    const wire: string[] = [];
    const c = new AudioStreamClient({ send: (s) => wire.push(s), language: "en" });
    c.sendFloat32(new Float32Array(4800), 48000); // 100 ms at 48 kHz
    const chunk = JSON.parse(wire[1]!) as { data: string; seq: number };
    expect(Buffer.from(chunk.data, "base64").byteLength).toBe(3200);
    expect(chunk.seq).toBe(0);
  });

  it("validates input and reports errors instead of throwing", async () => {
    const { mgr, toClient } = setup();
    await mgr.handle("c", "not json");
    await mgr.handle("c", { type: "audio.start", streamId: "x", language: "sv", sampleRate: 999999, encoding: "pcm16" });
    await mgr.handle("c", { type: "audio.chunk", streamId: "ghost", seq: 0, data: "" });
    expect(toClient.map((m) => (m.msg.type === "transcript.error" ? m.msg.code : m.msg.type))).toEqual(["BAD_INPUT", "BAD_INPUT", "NOT_FOUND"]);
  });

  it("enforces per-connection stream limits, drops duplicate seqs and caps stream length", async () => {
    const { mgr, toClient, done } = setup();
    await mgr.handle("c", { type: "audio.start", streamId: "a", language: "sv", sampleRate: 16000, encoding: "pcm16" });
    await mgr.handle("c", { type: "audio.start", streamId: "b", language: "sv", sampleRate: 16000, encoding: "pcm16" });
    expect(toClient.at(-1)!.msg).toMatchObject({ type: "transcript.error", code: "RATE_LIMITED", streamId: "b" });
    const oneSec = Buffer.from(int16ToBytes(new Int16Array(16000))).toString("base64");
    await mgr.handle("c", { type: "audio.chunk", streamId: "a", seq: 0, data: oneSec });
    await mgr.handle("c", { type: "audio.chunk", streamId: "a", seq: 0, data: oneSec }); // duplicate
    await mgr.handle("c", { type: "audio.stop", streamId: "a" });
    expect(done[0]!.t.durationSec).toBeCloseTo(1, 6);

    await mgr.handle("c", { type: "audio.start", streamId: "long", language: "sv", sampleRate: 16000, encoding: "pcm16" });
    for (let i = 0; i < 6; i++) await mgr.handle("c", { type: "audio.chunk", streamId: "long", seq: i, data: oneSec });
    expect(toClient.some((m) => m.msg.type === "transcript.error" && /maximum length/.test(m.msg.message))).toBe(true);
    expect(done[1]!.t.durationSec).toBeCloseTo(5, 6);
    expect(mgr.activeStreams).toBe(0);
  });

  it("finishes open streams when the connection drops", async () => {
    const { mgr, done } = setup();
    await mgr.handle("c", { type: "audio.start", streamId: "a", language: "sv", sampleRate: 16000, encoding: "pcm16" });
    await mgr.disconnect("c");
    expect(done).toHaveLength(1);
    expect(mgr.activeStreams).toBe(0);
  });
});
