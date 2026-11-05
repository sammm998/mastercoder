import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeError, LocalObjectStore } from "@forge/shared";
import { ChunkedUploadService, InMemoryChunkRepo, sha256Hex } from "../src/upload.js";

function bytes(n: number, seed = 1): Uint8Array {
  const b = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    b[i] = x & 0xff;
  }
  return b;
}

describe("ChunkedUploadService", () => {
  let store: LocalObjectStore;
  let svc: ChunkedUploadService;
  const file = bytes(10_000);
  const chunkSize = 4096;
  const parts = [file.subarray(0, 4096), file.subarray(4096, 8192), file.subarray(8192)];

  beforeEach(() => {
    store = new LocalObjectStore(mkdtempSync(join(tmpdir(), "forge-upl-")));
    svc = new ChunkedUploadService(store, new InMemoryChunkRepo(), { minChunkSize: 1024 });
  });

  it("uploads out of order, resumes from status and assembles in order", async () => {
    const { uploadId, totalChunks } = await svc.init({ meetingId: "mtg_a", totalSize: file.byteLength, mimeType: "audio/webm", chunkSize, sha256: sha256Hex(file) });
    expect(totalChunks).toBe(3);
    expect(await svc.putChunk(uploadId, 2, parts[2]!, sha256Hex(parts[2]!))).toEqual({ status: "stored" });
    expect(await svc.putChunk(uploadId, 0, parts[0]!, sha256Hex(parts[0]!))).toEqual({ status: "stored" });
    // connection drops; client asks what is missing
    const st = await svc.status(uploadId);
    expect(st).toMatchObject({ received: [0, 2], missing: [1], bytesReceived: 4096 + 1808, complete: false, meetingId: "mtg_a" });
    await expect(svc.complete(uploadId)).rejects.toThrow(/missing chunks 1/);
    await svc.putChunk(uploadId, 1, parts[1]!, sha256Hex(parts[1]!));
    const done = await svc.complete(uploadId);
    expect(done).toEqual({ key: "meetings/mtg_a/audio.webm", size: 10_000, sha256: sha256Hex(file) });
    expect(Buffer.from(await store.get(done.key)).equals(Buffer.from(file))).toBe(true);
    // chunks cleaned up, complete() idempotent, status reports completion
    expect(await store.list(`uploads/${uploadId}/chunks/`)).toEqual([]);
    expect(await svc.complete(uploadId)).toEqual(done);
    expect(await svc.status(uploadId)).toMatchObject({ complete: true, missing: [], audioKey: done.key });
  });

  it("is idempotent for identical retries and rejects conflicting content", async () => {
    const { uploadId } = await svc.init({ meetingId: "mtg_b", totalSize: file.byteLength, mimeType: "audio/mp4", chunkSize });
    await svc.putChunk(uploadId, 0, parts[0]!, sha256Hex(parts[0]!));
    expect(await svc.putChunk(uploadId, 0, parts[0]!, sha256Hex(parts[0]!))).toEqual({ status: "duplicate" });
    const other = bytes(4096, 9);
    await expect(svc.putChunk(uploadId, 0, other, sha256Hex(other))).rejects.toThrow(/different content/);
  });

  it("verifies checksums, sizes and indexes", async () => {
    const { uploadId } = await svc.init({ meetingId: "mtg_c", totalSize: file.byteLength, mimeType: "audio/ogg", chunkSize });
    await expect(svc.putChunk(uploadId, 0, parts[0]!, sha256Hex(parts[1]!))).rejects.toThrow(/Checksum mismatch/);
    await expect(svc.putChunk(uploadId, 1, parts[2]!, sha256Hex(parts[2]!))).rejects.toThrow(/must be 4096 bytes/);
    await expect(svc.putChunk(uploadId, 3, parts[2]!, sha256Hex(parts[2]!))).rejects.toThrow(/out of range/);
    await expect(svc.status("upl_doesnotexist")).rejects.toThrow(ForgeError);
    await expect(svc.status("../../etc")).rejects.toThrow(/Invalid uploadId/);
  });

  it("validates init input", async () => {
    await expect(svc.init({ meetingId: "../x", totalSize: 10, mimeType: "audio/webm", chunkSize: 1024 })).rejects.toThrow();
    await expect(svc.init({ meetingId: "m", totalSize: 10, mimeType: "application/pdf", chunkSize: 1024 })).rejects.toThrow(/Unsupported audio type/);
    await expect(svc.init({ meetingId: "m", totalSize: 10_000, mimeType: "audio/webm", chunkSize: 10 })).rejects.toThrow(/chunkSize/);
    const big = new ChunkedUploadService(store, new InMemoryChunkRepo(), { maxTotalSize: 100 });
    await expect(big.init({ meetingId: "m", totalSize: 101, mimeType: "audio/webm", chunkSize: 101 })).rejects.toThrow(/too large/);
  });

  it("detects a whole-file checksum mismatch", async () => {
    const { uploadId } = await svc.init({ meetingId: "mtg_d", totalSize: file.byteLength, mimeType: "audio/wav", chunkSize, sha256: "0".repeat(64) });
    for (const [i, p] of parts.entries()) await svc.putChunk(uploadId, i, p, sha256Hex(p));
    await expect(svc.complete(uploadId)).rejects.toThrow(/Whole-file checksum/);
  });
});
