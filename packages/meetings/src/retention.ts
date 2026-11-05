import { ForgeError, createLogger, type ObjectStore } from "@forge/shared";
import type { MeetingRecord, MeetingRepo } from "./types.js";
import type { ChunkRepo } from "./upload.js";

export type RetentionKind = "audio" | "transcript" | "extraction";

/** Days each kind of meeting data is kept (GDPR data minimization: raw audio shortest). */
export interface RetentionPolicy {
  audioDays: number;
  transcriptDays: number;
  /** Extraction + spec (the derived requirements). */
  extractionDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { audioDays: 30, transcriptDays: 180, extractionDays: 365 };

export function retentionUntil(policy: RetentionPolicy, kind: RetentionKind, from: Date = new Date()): Date {
  const days = kind === "audio" ? policy.audioDays : kind === "transcript" ? policy.transcriptDays : policy.extractionDays;
  if (!Number.isFinite(days) || days < 0) throw new ForgeError("BAD_INPUT", `Invalid retention for ${kind}: ${days}`);
  return new Date(from.getTime() + days * 86_400_000);
}

/** All three deadlines for a new meeting. */
export function retentionFor(policy: RetentionPolicy, from: Date = new Date()): MeetingRecord["retention"] {
  return {
    audio: retentionUntil(policy, "audio", from).toISOString(),
    transcript: retentionUntil(policy, "transcript", from).toISOString(),
    extraction: retentionUntil(policy, "extraction", from).toISOString(),
  };
}

export function meetingPrefix(meetingId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(meetingId)) throw new ForgeError("BAD_INPUT", `Invalid meeting id ${meetingId}`);
  return `meetings/${meetingId}/`;
}

async function deleteAudio(store: ObjectStore, m: MeetingRecord): Promise<void> {
  const keys = new Set(await store.list(meetingPrefix(m.id)));
  if (m.audioKey) keys.add(m.audioKey);
  for (const k of keys) await store.delete(k);
}

export interface PurgeReport {
  audio: string[];
  transcript: string[];
  extraction: string[];
}

/** Delete every kind of data whose deadline has passed. Idempotent; safe to run from a cron job. */
export async function purgeExpired(repo: MeetingRepo, store: ObjectStore, now: Date = new Date()): Promise<PurgeReport> {
  const log = createLogger({ component: "meetings.retention" });
  const report: PurgeReport = { audio: [], transcript: [], extraction: [] };
  const due = (iso?: string) => iso !== undefined && Date.parse(iso) <= now.getTime();
  for (const m of await repo.listExpired(now)) {
    const patch: Partial<MeetingRecord> = {};
    if (due(m.retention.audio) && m.audioKey) {
      await deleteAudio(store, m);
      patch.audioKey = undefined;
      report.audio.push(m.id);
    }
    if (due(m.retention.transcript) && m.transcript) {
      patch.transcript = undefined;
      report.transcript.push(m.id);
    }
    if (due(m.retention.extraction) && (m.extraction || m.spec)) {
      patch.extraction = undefined;
      patch.spec = undefined;
      report.extraction.push(m.id);
    }
    if (Object.keys(patch).length) await repo.update(m.id, patch);
  }
  log.info("retention purge", { audio: report.audio.length, transcript: report.transcript.length, extraction: report.extraction.length });
  return report;
}

export interface DeleteMeetingDeps {
  repo: MeetingRepo;
  store: ObjectStore;
  /** Also drop in-flight upload chunks for these upload ids. */
  chunks?: { repo: ChunkRepo; uploadIds: string[] };
  now?: Date;
}

/** Right to erasure: remove audio, transcript, extraction and spec; the row stays as a tombstone (status "deleted"). */
export async function deleteMeeting(id: string, deps: DeleteMeetingDeps): Promise<void> {
  const m = await deps.repo.get(id);
  if (!m) throw new ForgeError("NOT_FOUND", `Meeting ${id} not found`);
  await deleteAudio(deps.store, m);
  for (const uploadId of deps.chunks?.uploadIds ?? []) {
    for (const c of await deps.chunks!.repo.list(uploadId)) await deps.store.delete(c.storageKey);
    for (const k of await deps.store.list(`uploads/${uploadId}/`)) await deps.store.delete(k);
    await deps.chunks!.repo.deleteUpload(uploadId);
  }
  await deps.repo.update(id, {
    status: "deleted",
    audioKey: undefined,
    transcript: undefined,
    extraction: undefined,
    spec: undefined,
    stopRequest: undefined,
    deletedAt: (deps.now ?? new Date()).toISOString(),
  });
}
