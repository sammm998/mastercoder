import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildServer } from "../src/server.js";
import { wireServices } from "../src/wiring.js";
import { signup, testDeps, uniq } from "./helpers.js";

let deps: Awaited<ReturnType<typeof testDeps>>;
let http = "";
let ws = "";
let close: () => Promise<void>;

beforeAll(async () => {
  process.env.STT_PROVIDER = "mock";
  process.env.MEDIA_PROVIDER = "mock";
  deps = await testDeps();
  const wired = await wireServices(deps);
  const { app } = await buildServer(deps, { audio: wired.audio, extensions: wired.extensions });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  http = `http://127.0.0.1:${port}`;
  ws = `ws://127.0.0.1:${port}`;
  close = async () => {
    await app.close();
    await deps.close();
  };
});
afterAll(async () => close());

describe("wired domain services", () => {
  it("estimates and moderates media through the media package", async () => {
    const a = await signup(deps, `md${uniq()}@test.local`);
    const { id: projectId } = await a.c.project.create({ workspaceId: a.workspaceId, name: "M" });
    const est = await a.c.media.estimate({ projectId, kind: "image-set", prompt: "minimalist Scandinavian coffee packaging", options: { n: 4 } });
    expect(est.highUsd).toBeGreaterThanOrEqual(0);
    await expect(a.c.media.generate({ projectId, kind: "image", prompt: "nude photo of a child", options: {} })).rejects.toThrow(/content policy/);
    const g = await a.c.media.generate({ projectId, kind: "image", prompt: "a ceramic coffee cup on oak", options: {} });
    expect(deps.queue.jobs.some((j) => (j.payload as { taskId?: string }).taskId === g.taskId)).toBe(true);
  });

  it("streams a voice prompt over /ws/audio and returns a final transcript", async () => {
    const a = await signup(deps, `au${uniq()}@test.local`);
    const { id: projectId } = await a.c.project.create({ workspaceId: a.workspaceId, name: "Voice" });
    const wav = readFileSync(fileURLToPath(new URL("../../../evals/fixtures/voice/todo-sv.wav", import.meta.url)));
    const pcm = wav.subarray(44);
    const sock = new WebSocket(`${ws}/ws/audio/${projectId}?lang=sv&token=${a.token}`);
    const msgs: Array<{ type: string; text?: string }> = [];
    const final = new Promise<{ type: string; text?: string }>((res, rej) => {
      sock.on("message", (d) => {
        const m = JSON.parse(d.toString()) as { type: string; text?: string };
        msgs.push(m);
        if (m.type === "transcript.final" || m.type === "transcript.done") res(m);
        if (m.type === "transcript.error") rej(new Error(JSON.stringify(m)));
      });
      setTimeout(() => rej(new Error(`timeout; got ${JSON.stringify(msgs)}`)), 10_000);
    });
    await new Promise((r) => sock.on("open", r));
    for (let i = 0; i < pcm.length; i += 32000) sock.send(pcm.subarray(i, i + 32000), { binary: true });
    sock.send(JSON.stringify({ type: "audio.stop" }));
    const m = await final;
    expect(m.type).toMatch(/transcript\.(final|done)/);
    sock.close();
  });

  it("uploads an in-person recording in resumable chunks", async () => {
    const a = await signup(deps, `up${uniq()}@test.local`);
    const audio = Buffer.alloc(200 * 1024, 7);
    const chunk = 64 * 1024;
    const r = await a.c.meetings.startRecording({ workspaceId: a.workspaceId, language: "sv", totalSize: audio.length, mimeType: "audio/wav", chunkSize: chunk });
    const put = (i: number) => {
      const body = audio.subarray(i * chunk, (i + 1) * chunk);
      return fetch(`${http}/uploads/${r.uploadId}/${i}`, { method: "PUT", headers: { authorization: `Bearer ${a.token}`, "content-type": "application/octet-stream", "x-chunk-sha256": createHash("sha256").update(body).digest("hex") }, body });
    };
    expect((await put(0)).status).toBe(200);
    expect((await put(2)).status).toBe(200);
    const st = await a.c.meetings.uploadStatus({ uploadId: r.uploadId });
    expect(st.missing).toEqual([1, 3]);
    expect((await put(1)).status).toBe(200);
    expect((await put(1)).status).toBe(200); // idempotent retry
    expect((await put(3)).status).toBe(200);
    const done = await a.c.meetings.completeRecording({ uploadId: r.uploadId });
    expect(done.size).toBe(audio.length);
    expect(deps.queue.jobs.some((j) => j.queue === "forge-transcription" && (j.payload as { meetingId: string }).meetingId === r.meetingId)).toBe(true);
    const bad = await fetch(`${http}/uploads/${r.uploadId}/0`, { method: "PUT", headers: { "content-type": "application/octet-stream", "x-chunk-sha256": "0".repeat(64) }, body: Buffer.alloc(10) });
    expect(bad.status).toBe(401);
  });
});
