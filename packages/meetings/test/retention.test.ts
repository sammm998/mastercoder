import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalObjectStore } from "@forge/shared";
import { DEFAULT_RETENTION, deleteMeeting, purgeExpired, retentionFor, retentionUntil } from "../src/retention.js";
import { InMemoryMeetingRepo } from "../src/repo.js";
import { ChunkedUploadService, InMemoryChunkRepo, sha256Hex } from "../src/upload.js";
import type { MeetingRecord } from "../src/types.js";

const t0 = new Date("2026-01-01T00:00:00Z");
const transcript = { text: "hej", language: "sv", durationSec: 1, segments: [], provider: "mock", model: "m" };
const extraction = { summary: "s", decisions: [], requirements: [], openQuestions: [], actionItems: [] };

function meeting(id: string): MeetingRecord {
  return {
    id,
    workspaceId: "ws",
    source: "recording",
    language: "sv",
    status: "ready",
    consentNoticePosted: true,
    audioKey: `meetings/${id}/audio.webm`,
    transcript,
    extraction,
    retention: retentionFor(DEFAULT_RETENTION, t0),
    createdAt: t0.toISOString(),
  };
}

describe("retention", () => {
  it("computes per-kind deadlines", () => {
    expect(retentionUntil(DEFAULT_RETENTION, "audio", t0).toISOString()).toBe("2026-01-31T00:00:00.000Z");
    expect(retentionUntil(DEFAULT_RETENTION, "transcript", t0).toISOString()).toBe("2026-06-30T00:00:00.000Z");
    expect(retentionUntil({ audioDays: 0, transcriptDays: 1, extractionDays: 2 }, "extraction", t0).toISOString()).toBe("2026-01-03T00:00:00.000Z");
    expect(() => retentionUntil({ audioDays: -1, transcriptDays: 1, extractionDays: 1 }, "audio", t0)).toThrow();
  });

  it("purges audio first, then transcripts, then extraction; idempotent", async () => {
    const store = new LocalObjectStore(mkdtempSync(join(tmpdir(), "forge-ret-")));
    const repo = new InMemoryMeetingRepo();
    await repo.create(meeting("m1"));
    await store.put("meetings/m1/audio.webm", new Uint8Array([1, 2, 3]));
    await store.put("meetings/m1/bot-recording.mp4", new Uint8Array([4]));

    expect(await purgeExpired(repo, store, new Date("2026-01-15T00:00:00Z"))).toEqual({ audio: [], transcript: [], extraction: [] });
    const r1 = await purgeExpired(repo, store, new Date("2026-02-01T00:00:00Z"));
    expect(r1.audio).toEqual(["m1"]);
    expect(await store.list("meetings/m1/")).toEqual([]);
    let m = await repo.get("m1");
    expect(m!.audioKey).toBeUndefined();
    expect(m!.transcript).toBeDefined();

    expect((await purgeExpired(repo, store, new Date("2026-02-02T00:00:00Z"))).audio).toEqual([]);
    const r2 = await purgeExpired(repo, store, new Date("2026-07-01T00:00:00Z"));
    expect(r2).toEqual({ audio: [], transcript: ["m1"], extraction: [] });
    const r3 = await purgeExpired(repo, store, new Date("2027-01-02T00:00:00Z"));
    expect(r3.extraction).toEqual(["m1"]);
    m = await repo.get("m1");
    expect(m!.transcript).toBeUndefined();
    expect(m!.extraction).toBeUndefined();
  });

  it("deleteMeeting erases audio, transcript, extraction, spec and in-flight chunks", async () => {
    const store = new LocalObjectStore(mkdtempSync(join(tmpdir(), "forge-del-")));
    const repo = new InMemoryMeetingRepo();
    const chunkRepo = new InMemoryChunkRepo();
    await repo.create({ ...meeting("m2"), spec: { title: "x", language: "sv", goals: [], userStories: [], entities: [], screens: [], integrations: [], suggestedIntents: [], acceptanceCriteria: [], openQuestions: [] } });
    await store.put("meetings/m2/audio.webm", new Uint8Array([1]));
    const up = new ChunkedUploadService(store, chunkRepo, { minChunkSize: 1 });
    const { uploadId } = await up.init({ meetingId: "m2", totalSize: 4, mimeType: "audio/webm", chunkSize: 2 });
    await up.putChunk(uploadId, 0, new Uint8Array([9, 9]), sha256Hex(new Uint8Array([9, 9])));

    await deleteMeeting("m2", { repo, store, chunks: { repo: chunkRepo, uploadIds: [uploadId] }, now: t0 });
    const m = await repo.get("m2");
    expect(m).toMatchObject({ status: "deleted", deletedAt: t0.toISOString() });
    expect(m!.transcript ?? m!.extraction ?? m!.spec ?? m!.audioKey).toBeUndefined();
    expect(await store.list("meetings/m2/")).toEqual([]);
    expect(await store.list(`uploads/${uploadId}/`)).toEqual([]);
    expect(await chunkRepo.list(uploadId)).toEqual([]);
    await expect(deleteMeeting("nope", { repo, store })).rejects.toThrow(/not found/);
  });
});
