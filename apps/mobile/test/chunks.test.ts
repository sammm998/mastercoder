import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  KeyValueUploadStore,
  MemoryKv,
  ResumableUploader,
  UploadAuthError,
  UploadHttpError,
  chunkCount,
  missingChunks,
  parseStoredUploads,
  planChunks,
  progressOf,
  toHex,
  type UploadApi,
} from "../src/lib/chunks.js";

describe("chunk planning", () => {
  it("splits into fixed-size chunks with a short last chunk", () => {
    expect(planChunks(10, 4)).toEqual([
      { index: 0, start: 0, end: 4 },
      { index: 1, start: 4, end: 8 },
      { index: 2, start: 8, end: 10 },
    ]);
    expect(chunkCount(8, 4)).toBe(2);
    expect(planChunks(0, 4)).toEqual([]);
  });
  it("computes missing chunks", () => {
    expect(missingChunks(5, [0, 3, 3])).toEqual([1, 2, 4]);
  });
  it("hex-encodes digests", () => {
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe("000fff");
  });
});

describe("persisted state", () => {
  it("drops malformed records", () => {
    expect(parseStoredUploads("not json")).toEqual([]);
    expect(parseStoredUploads(JSON.stringify([{ id: "x" }]))).toEqual([]);
  });
});

/** Fake API mirroring apps/api's UploadService semantics (sha verified, idempotent chunks, status, complete). */
class FakeServer implements UploadApi {
  uploads = new Map<string, { size: number; chunkSize: number; chunks: Map<number, Uint8Array>; done: boolean }>();
  failPuts = 0;
  failNetworkOn = new Set<number>();
  authExpired = false;
  puts: number[] = [];
  private n = 0;
  async startRecording(i: { totalSize: number; chunkSize: number }) {
    if (this.authExpired) throw new UploadHttpError(401, "unauthorized");
    const uploadId = `up_${++this.n}`;
    this.uploads.set(uploadId, { size: i.totalSize, chunkSize: i.chunkSize, chunks: new Map(), done: false });
    return { meetingId: `mtg_${this.n}`, uploadId, chunkSize: i.chunkSize };
  }
  async uploadStatus(id: string) {
    const u = this.uploads.get(id);
    if (!u) throw new UploadHttpError(404, "Upload not found");
    const total = Math.ceil(u.size / u.chunkSize);
    const received = [...u.chunks.keys()].sort((a, b) => a - b);
    return { received, missing: missingChunks(total, received), totalChunks: total };
  }
  async completeRecording(id: string) {
    const u = this.uploads.get(id);
    if (!u) throw new UploadHttpError(404, "Upload not found");
    const st = await this.uploadStatus(id);
    if (st.missing.length) throw new UploadHttpError(400, "missing chunks");
    u.done = true;
    return { ok: true, size: u.size };
  }
  async putChunk(id: string, index: number, bytes: Uint8Array, sha: string) {
    this.puts.push(index);
    if (this.authExpired) throw new UploadHttpError(401, "unauthorized");
    if (this.failNetworkOn.has(index)) {
      this.failNetworkOn.delete(index);
      throw new UploadHttpError(0, "Network request failed");
    }
    if (this.failPuts > 0) {
      this.failPuts--;
      throw new UploadHttpError(503, "unavailable");
    }
    const u = this.uploads.get(id);
    if (!u) throw new UploadHttpError(404, "upload not found");
    if (createHash("sha256").update(bytes).digest("hex") !== sha) throw new UploadHttpError(400, "checksum mismatch");
    u.chunks.set(index, bytes);
  }
  assembled(id: string): Uint8Array {
    const u = this.uploads.get(id)!;
    const out = new Uint8Array(u.size);
    for (const [i, b] of u.chunks) out.set(b, i * u.chunkSize);
    return out;
  }
}

function setup(opts: { size?: number; chunkSize?: number } = {}) {
  const size = opts.size ?? 10_000;
  const file = new Uint8Array(size).map((_, i) => (i * 7) % 251);
  const files = new Map<string, Uint8Array>([["file:///rec.m4a", file]]);
  const server = new FakeServer();
  const kv = new MemoryKv();
  const store = new KeyValueUploadStore(kv);
  let id = 0;
  const make = () =>
    new ResumableUploader({
      api: server,
      store,
      readChunk: async (uri, start, len) => {
        const f = files.get(uri);
        if (!f) throw new Error("ENOENT");
        return f.slice(start, start + len);
      },
      sha256Hex: async (b) => createHash("sha256").update(b).digest("hex"),
      newId: () => `loc_${++id}`,
      sleep: async () => undefined,
      random: () => 0.5,
      concurrency: 2,
    });
  const input = { fileUri: "file:///rec.m4a", totalSize: size, mimeType: "audio/mp4", workspaceId: "ws_1", title: "Kickoff", language: "sv" as const, chunkSize: opts.chunkSize ?? 1024 };
  return { server, kv, store, make, input, file, files };
}

describe("ResumableUploader", () => {
  it("saves locally first, then uploads every chunk and completes", async () => {
    const { server, store, make, input, file } = setup();
    const up = make();
    const local = await up.saveLocal(input);
    expect(local.status).toBe("local");
    expect(local.uploadId).toBeUndefined();
    expect((await store.get(local.id))?.status).toBe("local");

    const progress: number[] = [];
    const done = await up.run(local.id, { onProgress: (p) => progress.push(p.receivedChunks) });
    expect(done.status).toBe("done");
    expect(done.uploadId).toBe("up_1");
    expect(done.meetingId).toBe("mtg_1");
    expect(server.uploads.get("up_1")!.done).toBe(true);
    expect(server.assembled("up_1")).toEqual(file);
    expect(Math.max(...progress)).toBe(10);
    expect(progressOf(done).fraction).toBe(1);
  });

  it("resumes after an app restart, sending only the chunks the server is missing", async () => {
    const { server, make, input, kv } = setup();
    const first = make();
    const local = await first.saveLocal(input);
    // Simulate the app being killed after 4 chunks: run with an abort after progress reaches 4.
    const ac = new AbortController();
    await expect(
      first.run(local.id, {
        signal: ac.signal,
        onProgress: (p) => {
          if (p.receivedChunks >= 4) ac.abort();
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    const alreadyThere = new Set(server.uploads.get("up_1")!.chunks.keys());
    const sentBefore = alreadyThere.size;
    expect(sentBefore).toBeGreaterThanOrEqual(4);
    expect(sentBefore).toBeLessThan(10);

    // New process: fresh uploader, same persisted KV.
    server.puts = [];
    const second = make();
    expect(kv.data.size).toBe(1);
    const results = await second.resumeAll();
    expect(results[0]?.result?.status).toBe("done");
    // Only missing chunks were sent, none of the already-received ones.
    for (const i of server.puts) expect(alreadyThere.has(i)).toBe(false);
    expect(new Set(server.puts).size).toBe(10 - sentBefore);
    expect(server.uploads.get("up_1")!.done).toBe(true);
  });

  it("retries transient network and 5xx failures with backoff", async () => {
    const { server, make, input, file } = setup();
    server.failPuts = 3;
    server.failNetworkOn.add(7);
    const up = make();
    const local = await up.saveLocal(input);
    const done = await up.run(local.id);
    expect(done.status).toBe("done");
    expect(server.assembled("up_1")).toEqual(file);
  });

  it("keeps state and rethrows when retries are exhausted, then a later run finishes", async () => {
    const { server, make, input, store } = setup();
    server.failPuts = 100;
    const up = make();
    const local = await up.saveLocal(input);
    await expect(up.run(local.id)).rejects.toBeInstanceOf(UploadHttpError);
    const mid = await store.get(local.id);
    expect(mid?.status).toBe("uploading");
    expect(mid?.error).toMatch(/unavailable/);
    server.failPuts = 0;
    expect((await up.run(local.id)).status).toBe("done");
  });

  it("stays local when offline at start and promotes once the network is back", async () => {
    const { server, make, input, store } = setup();
    const up = make();
    const local = await up.saveLocal(input);
    const orig = server.startRecording.bind(server);
    server.startRecording = async () => {
      throw new UploadHttpError(0, "Network request failed");
    };
    await expect(up.run(local.id)).rejects.toBeInstanceOf(UploadHttpError);
    expect((await store.get(local.id))?.status).toBe("local");
    server.startRecording = orig;
    expect((await up.run(local.id)).status).toBe("done");
  });

  it("marks an upload the server forgot as expired, and restart re-uploads it", async () => {
    const { server, make, input } = setup();
    const up = make();
    const local = await up.saveLocal(input);
    server.failPuts = 100;
    await expect(up.run(local.id)).rejects.toThrow();
    server.uploads.clear();
    server.failPuts = 0;
    const expired = await up.run(local.id);
    expect(expired.status).toBe("expired");
    const fresh = await up.restart(local.id);
    expect(fresh.status).toBe("done");
    expect(fresh.id).toBe(local.id);
    expect(fresh.uploadId).toBe("up_2");
  });

  it("stops on auth errors without losing state", async () => {
    const { server, make, input, store } = setup();
    const up = make();
    const local = await up.saveLocal(input);
    server.authExpired = true;
    await expect(up.run(local.id)).rejects.toBeInstanceOf(UploadAuthError);
    expect((await store.get(local.id))?.status).toBe("local");
  });

  it("fails clearly when the recording file is gone", async () => {
    const { make, input, files } = setup();
    const up = make();
    const local = await up.saveLocal(input);
    files.clear();
    const r = await up.run(local.id);
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/unreadable/);
  });

  it("shares one run for concurrent calls on the same upload", async () => {
    const { server, make, input } = setup();
    const up = make();
    const local = await up.saveLocal(input);
    const [a, b] = await Promise.all([up.run(local.id), up.run(local.id)]);
    expect(a).toEqual(b);
    expect(server.puts.length).toBe(10);
  });

  it("detects chunk plan mismatch", async () => {
    const { server, make, input } = setup();
    const up = make();
    const local = await up.saveLocal(input);
    server.uploadStatus = async () => ({ received: [], missing: [0], totalChunks: 1 });
    const r = await up.run(local.id);
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/mismatch/);
  });

  it("serialises concurrent store writes", async () => {
    const kv = new MemoryKv();
    const store = new KeyValueUploadStore(kv);
    const base = { version: 1 as const, workspaceId: "w", fileUri: "f", totalSize: 1, chunkSize: 1, mimeType: "a", title: "t", language: "en" as const, createdAt: "", updatedAt: "", received: [], status: "local" as const };
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.put({ ...base, id: `u${i}` })));
    expect((await store.list()).length).toBe(20);
  });
});
