import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { connect, runMigrations, uploadChunks, eq, type DbHandle } from "@forge/db";
// @forge/shared exports only "."; its S3 adapter is imported by path (see README "Needed changes elsewhere").
import { S3ObjectStore, ensureBuckets } from "../../shared/src/adapters/s3.js";
import { ChunkedUploadService, DrizzleChunkRepo, sha256Hex, deleteMeeting, InMemoryMeetingRepo } from "../src/index.js";

const s3 = { endpoint: process.env.S3_ENDPOINT || "http://localhost:9000", region: "eu-central-1", accessKeyId: "forge", secretAccessKey: "forgeforge" };
const BUCKET = "forge-meetings-test";

let h: DbHandle;
let store: S3ObjectStore;

beforeAll(async () => {
  await runMigrations();
  h = connect();
  await ensureBuckets(s3, [BUCKET]);
  store = new S3ObjectStore({ ...s3, bucket: BUCKET });
});
afterAll(async () => h?.close());

describe("chunked upload on Postgres (upload_chunks) + S3 (SeaweedFS)", () => {
  it("resumes an interrupted upload and assembles the recording", async () => {
    const repo = new DrizzleChunkRepo(h.db);
    const svc = new ChunkedUploadService(store, repo, { minChunkSize: 64 * 1024 });
    const file = new Uint8Array(randomBytes(64 * 1024 * 3 + 12_345));
    const cs = 64 * 1024;
    const meetingId = `mtg_int_${Date.now()}`;
    const { uploadId, totalChunks } = await svc.init({ meetingId, totalSize: file.byteLength, mimeType: "audio/webm", chunkSize: cs, sha256: sha256Hex(file) });
    expect(totalChunks).toBe(4);
    const part = (i: number) => file.subarray(i * cs, Math.min((i + 1) * cs, file.byteLength));

    await svc.putChunk(uploadId, 0, part(0), sha256Hex(part(0)));
    await svc.putChunk(uploadId, 3, part(3), sha256Hex(part(3)));
    // concurrent duplicate retries of the same chunk are idempotent
    const dup = await Promise.all([svc.putChunk(uploadId, 1, part(1), sha256Hex(part(1))), svc.putChunk(uploadId, 1, part(1), sha256Hex(part(1)))]);
    expect(dup.map((d) => d.status).sort()).toEqual(["duplicate", "stored"]);

    const st = await svc.status(uploadId);
    expect(st.received).toEqual([0, 1, 3]);
    expect(st.missing).toEqual([2]);
    const rows = await h.db.select().from(uploadChunks).where(eq(uploadChunks.uploadId, uploadId));
    expect(rows).toHaveLength(3);

    await svc.putChunk(uploadId, 2, part(2), sha256Hex(part(2)));
    const done = await svc.complete(uploadId);
    expect(done.key).toBe(`meetings/${meetingId}/audio.webm`);
    expect(done.size).toBe(file.byteLength);
    expect(Buffer.from(await store.get(done.key)).equals(Buffer.from(file))).toBe(true);
    expect(await store.list(`uploads/${uploadId}/chunks/`)).toEqual([]);

    // GDPR erasure removes the assembled audio and the chunk rows
    const meetings = new InMemoryMeetingRepo();
    await meetings.create({ id: meetingId, workspaceId: "ws", source: "recording", language: "sv", status: "ready", consentNoticePosted: true, audioKey: done.key, retention: {}, createdAt: new Date().toISOString() });
    await deleteMeeting(meetingId, { repo: meetings, store, chunks: { repo, uploadIds: [uploadId] } });
    expect(await store.exists(done.key)).toBe(false);
    expect(await repo.list(uploadId)).toEqual([]);
  });
});
