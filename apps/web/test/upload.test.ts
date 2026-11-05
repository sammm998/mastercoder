import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { ChunkUploadError, chunkCount, chunkRange, httpTransport, sha256Hex, uploadChunks, type ChunkTransport, type UploadStatus } from "../src/lib/upload";

/** In-memory server mirroring the API's upload service: verifies hashes, tracks received chunks. */
function fakeServer(totalChunks: number, opts: { preReceived?: number[]; failTimes?: Record<number, number>; fatal?: number[] } = {}) {
  const received = new Map<number, Uint8Array>();
  for (const i of opts.preReceived ?? []) received.set(i, new Uint8Array());
  const failures = { ...(opts.failTimes ?? {}) };
  const puts: number[] = [];
  const transport: ChunkTransport = {
    async status(): Promise<UploadStatus> {
      const r = [...received.keys()].sort((a, b) => a - b);
      return { received: r, missing: Array.from({ length: totalChunks }, (_, i) => i).filter((i) => !received.has(i)), totalChunks };
    },
    async putChunk(index, bytes, sha) {
      puts.push(index);
      if (opts.fatal?.includes(index)) throw new ChunkUploadError("bad chunk", 400);
      if ((failures[index] ?? 0) > 0) {
        failures[index]!--;
        throw new ChunkUploadError("network down");
      }
      expect(sha).toBe(createHash("sha256").update(bytes).digest("hex"));
      received.set(index, bytes);
    },
  };
  return { transport, received, puts };
}

const blobOf = (size: number) => new Blob([Uint8Array.from({ length: size }, (_, i) => i % 251)]);
const noSleep = () => Promise.resolve();

describe("chunk maths", () => {
  it("counts and slices chunks", () => {
    expect(chunkCount(10, 4)).toBe(3);
    expect(chunkCount(8, 4)).toBe(2);
    expect(chunkCount(0, 4)).toBe(1);
    expect(chunkRange(2, 4, 10)).toEqual([8, 10]);
    expect(() => chunkCount(1, 0)).toThrow();
  });

  it("hashes with SHA-256", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("uploadChunks", () => {
  it("uploads every chunk with a valid hash and reports progress", async () => {
    const blob = blobOf(10_000);
    const s = fakeServer(chunkCount(blob.size, 4096));
    const progress: number[] = [];
    const status = await uploadChunks(blob, s.transport, { chunkSize: 4096, onProgress: (d) => progress.push(d), sleep: noSleep });
    expect(status.missing).toEqual([]);
    expect(s.received.size).toBe(3);
    expect(progress.at(-1)).toBe(3);
    const joined = new Uint8Array([...s.received.get(0)!, ...s.received.get(1)!, ...s.received.get(2)!]);
    expect(joined.length).toBe(10_000);
    expect(joined[5000]).toBe(5000 % 251);
  });

  it("resumes: only sends chunks the server is missing", async () => {
    const blob = blobOf(5 * 1000);
    const s = fakeServer(5, { preReceived: [0, 1, 3] });
    await uploadChunks(blob, s.transport, { chunkSize: 1000, sleep: noSleep });
    expect(s.puts.sort()).toEqual([2, 4]);
  });

  it("retries transient failures with backoff", async () => {
    const sleep = vi.fn((_ms: number) => Promise.resolve());
    const s = fakeServer(2, { failTimes: { 1: 2 } });
    await uploadChunks(blobOf(2000), s.transport, { chunkSize: 1000, sleep, backoffMs: 100 });
    expect(s.received.size).toBe(2);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
  });

  it("gives up after the retry budget", async () => {
    const s = fakeServer(1, { failTimes: { 0: 10 } });
    await expect(uploadChunks(blobOf(10), s.transport, { chunkSize: 1000, retries: 2, sleep: noSleep })).rejects.toThrow(/network down/);
  });

  it("does not retry 4xx responses", async () => {
    const s = fakeServer(1, { fatal: [0] });
    await expect(uploadChunks(blobOf(10), s.transport, { chunkSize: 1000, sleep: noSleep })).rejects.toThrow(/bad chunk/);
    expect(s.puts).toEqual([0]);
  });

  it("returns immediately when the upload is already complete", async () => {
    const s = fakeServer(2, { preReceived: [0, 1] });
    await uploadChunks(blobOf(2000), s.transport, { chunkSize: 1000, sleep: noSleep });
    expect(s.puts).toEqual([]);
  });

  it("honours abort signals", async () => {
    const ac = new AbortController();
    ac.abort();
    const s = fakeServer(1);
    await expect(uploadChunks(blobOf(10), s.transport, { chunkSize: 1000, signal: ac.signal, sleep: noSleep })).rejects.toThrow(/abort/i);
  });
});

describe("httpTransport", () => {
  it("PUTs octet-stream chunks with the hash header and cookies", async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true, received: 1 }), { status: 200 }));
    const t = httpTransport({ apiUrl: "http://api.test", uploadId: "upl_1", status: async () => ({ received: [], missing: [0], totalChunks: 1 }), fetchImpl: f as unknown as typeof fetch });
    await t.putChunk(3, new Uint8Array([1, 2]), "a".repeat(64));
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("http://api.test/uploads/upl_1/3");
    expect(init?.method).toBe("PUT");
    expect(init?.credentials).toBe("include");
    expect(init?.headers).toMatchObject({ "content-type": "application/octet-stream", "x-chunk-sha256": "a".repeat(64) });
  });

  it("turns HTTP errors into ChunkUploadError with the status", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: "hash mismatch" }), { status: 400 }));
    const t = httpTransport({ apiUrl: "http://api.test", uploadId: "u", status: async () => ({ received: [], missing: [], totalChunks: 0 }), fetchImpl: f as unknown as typeof fetch });
    const err = await t.putChunk(0, new Uint8Array([1]), "b".repeat(64)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChunkUploadError);
    expect((err as ChunkUploadError).status).toBe(400);
    expect((err as Error).message).toBe("hash mismatch");
  });
});
