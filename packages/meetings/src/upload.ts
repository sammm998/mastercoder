import { createHash } from "node:crypto";
import { z } from "zod";
import { ForgeError, newId, type ObjectStore } from "@forge/shared";
import { meetingPrefix } from "./retention.js";

/**
 * Chunked, resumable upload for in-person meeting recordings (mobile app records offline, uploads in chunks
 * over flaky networks). Chunks are content-addressed by sha256 and idempotent; the upload manifest lives in the
 * object store next to the chunks; chunk bookkeeping lives in a ChunkRepo (`upload_chunks` table in production).
 */
export interface ChunkRecord {
  uploadId: string;
  index: number;
  storageKey: string;
  size: number;
  sha256: string;
}

export interface ChunkRepo {
  /** Insert unless (uploadId, index) exists; returns the stored row (existing or new). */
  insertIfAbsent(c: ChunkRecord): Promise<{ row: ChunkRecord; inserted: boolean }>;
  list(uploadId: string): Promise<ChunkRecord[]>;
  deleteUpload(uploadId: string): Promise<void>;
}

export class InMemoryChunkRepo implements ChunkRepo {
  private rows = new Map<string, ChunkRecord>();
  async insertIfAbsent(c: ChunkRecord) {
    const k = `${c.uploadId}#${c.index}`;
    const existing = this.rows.get(k);
    if (existing) return { row: { ...existing }, inserted: false };
    this.rows.set(k, { ...c });
    return { row: { ...c }, inserted: true };
  }
  async list(uploadId: string) {
    return [...this.rows.values()].filter((r) => r.uploadId === uploadId).sort((a, b) => a.index - b.index).map((r) => ({ ...r }));
  }
  async deleteUpload(uploadId: string) {
    for (const [k, r] of this.rows) if (r.uploadId === uploadId) this.rows.delete(k);
  }
}

const MIME_EXT: Record<string, string> = {
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/flac": "flac",
  "audio/3gpp": "3gp",
};

export function extensionForAudioMime(mime: string): string {
  const ext = MIME_EXT[mime.split(";")[0]?.trim().toLowerCase() ?? ""];
  if (!ext) throw new ForgeError("BAD_INPUT", `Unsupported audio type ${mime}`);
  return ext;
}

const InitSchema = z.object({
  meetingId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  totalSize: z.number().int().positive(),
  mimeType: z.string().min(3).max(100),
  chunkSize: z.number().int().positive(),
  /** Optional sha256 of the whole file, verified on complete(). */
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
});
export type InitUploadInput = z.infer<typeof InitSchema>;

const ManifestSchema = InitSchema.extend({
  uploadId: z.string(),
  totalChunks: z.number().int().positive(),
  createdAt: z.string(),
  completed: z.object({ key: z.string(), size: z.number(), sha256: z.string(), at: z.string() }).optional(),
});
type Manifest = z.infer<typeof ManifestSchema>;

export interface UploadStatus {
  uploadId: string;
  meetingId: string;
  totalChunks: number;
  received: number[];
  missing: number[];
  bytesReceived: number;
  complete: boolean;
  audioKey?: string;
}

export interface ChunkedUploadOptions {
  /** Default 5 GiB. */
  maxTotalSize?: number;
  /** Bounds for the client-chosen chunk size (default 64 KiB … 64 MiB). */
  minChunkSize?: number;
  maxChunkSize?: number;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class ChunkedUploadService {
  private readonly maxTotal: number;
  private readonly minChunk: number;
  private readonly maxChunk: number;
  constructor(
    private readonly store: ObjectStore,
    private readonly chunks: ChunkRepo,
    opts: ChunkedUploadOptions = {},
  ) {
    this.maxTotal = opts.maxTotalSize ?? 5 * 1024 ** 3;
    this.minChunk = opts.minChunkSize ?? 64 * 1024;
    this.maxChunk = opts.maxChunkSize ?? 64 * 1024 ** 2;
  }

  private manifestKey(uploadId: string): string {
    if (!/^upl_[a-z0-9]+$/.test(uploadId)) throw new ForgeError("BAD_INPUT", "Invalid uploadId");
    return `uploads/${uploadId}/manifest.json`;
  }

  private async manifest(uploadId: string): Promise<Manifest> {
    const key = this.manifestKey(uploadId);
    if (!(await this.store.exists(key))) throw new ForgeError("NOT_FOUND", `Upload ${uploadId} not found`);
    return ManifestSchema.parse(JSON.parse(new TextDecoder().decode(await this.store.get(key))));
  }

  async init(input: InitUploadInput): Promise<{ uploadId: string; totalChunks: number; chunkSize: number }> {
    const i = InitSchema.parse(input);
    extensionForAudioMime(i.mimeType);
    if (i.totalSize > this.maxTotal) throw new ForgeError("BAD_INPUT", `Recording too large (${i.totalSize} > ${this.maxTotal} bytes)`);
    if (i.chunkSize < Math.min(this.minChunk, i.totalSize) || i.chunkSize > this.maxChunk) {
      throw new ForgeError("BAD_INPUT", `chunkSize must be between ${this.minChunk} and ${this.maxChunk} bytes`);
    }
    const uploadId = newId("upl");
    const totalChunks = Math.ceil(i.totalSize / i.chunkSize);
    const m: Manifest = { ...i, uploadId, totalChunks, createdAt: new Date().toISOString() };
    await this.store.put(this.manifestKey(uploadId), JSON.stringify(m), { contentType: "application/json" });
    return { uploadId, totalChunks, chunkSize: i.chunkSize };
  }

  private expectedSize(m: Manifest, index: number): number {
    return index === m.totalChunks - 1 ? m.totalSize - m.chunkSize * (m.totalChunks - 1) : m.chunkSize;
  }

  /** Idempotent: re-sending an identical chunk is a no-op; a different body for a stored index is rejected. */
  async putChunk(uploadId: string, index: number, bytes: Uint8Array, sha256: string): Promise<{ status: "stored" | "duplicate" }> {
    const m = await this.manifest(uploadId);
    if (m.completed) throw new ForgeError("BAD_INPUT", "Upload already completed");
    if (!Number.isInteger(index) || index < 0 || index >= m.totalChunks) throw new ForgeError("BAD_INPUT", `Chunk index ${index} out of range 0..${m.totalChunks - 1}`);
    const expected = this.expectedSize(m, index);
    if (bytes.byteLength !== expected) throw new ForgeError("BAD_INPUT", `Chunk ${index} must be ${expected} bytes, got ${bytes.byteLength}`);
    const actual = sha256Hex(bytes);
    if (actual !== sha256.toLowerCase()) throw new ForgeError("BAD_INPUT", `Checksum mismatch for chunk ${index}`, { expected: sha256, actual });
    const storageKey = `uploads/${uploadId}/chunks/${String(index).padStart(6, "0")}`;
    const existing = (await this.chunks.list(uploadId)).find((c) => c.index === index);
    if (existing) {
      if (existing.sha256 !== actual) throw new ForgeError("BAD_INPUT", `Chunk ${index} already stored with different content`);
      return { status: "duplicate" };
    }
    // Object first, then the row: a row always implies its bytes exist.
    await this.store.put(storageKey, bytes, { contentType: "application/octet-stream" });
    const r = await this.chunks.insertIfAbsent({ uploadId, index, storageKey, size: bytes.byteLength, sha256: actual });
    if (!r.inserted && r.row.sha256 !== actual) throw new ForgeError("BAD_INPUT", `Chunk ${index} already stored with different content`);
    return { status: r.inserted ? "stored" : "duplicate" };
  }

  async status(uploadId: string): Promise<UploadStatus> {
    const m = await this.manifest(uploadId);
    const rows = await this.chunks.list(uploadId);
    const have = new Set(rows.map((r) => r.index));
    const missing: number[] = [];
    for (let i = 0; i < m.totalChunks; i++) if (!have.has(i)) missing.push(i);
    const s: UploadStatus = {
      uploadId,
      meetingId: m.meetingId,
      totalChunks: m.totalChunks,
      received: [...have].sort((a, b) => a - b),
      missing: m.completed ? [] : missing,
      bytesReceived: m.completed ? m.totalSize : rows.reduce((a, r) => a + r.size, 0),
      complete: Boolean(m.completed),
    };
    if (m.completed) s.audioKey = m.completed.key;
    return s;
  }

  /** Concatenate chunks in order into meetings/<id>/audio.<ext>, verify size (+ optional sha256), clean up chunks. */
  async complete(uploadId: string): Promise<{ key: string; size: number; sha256: string }> {
    const m = await this.manifest(uploadId);
    if (m.completed) return { key: m.completed.key, size: m.completed.size, sha256: m.completed.sha256 };
    const rows = await this.chunks.list(uploadId);
    const st = await this.status(uploadId);
    if (st.missing.length) throw new ForgeError("BAD_INPUT", `Upload incomplete: missing chunks ${st.missing.slice(0, 20).join(", ")}`, { missing: st.missing });
    const out = new Uint8Array(m.totalSize);
    const hash = createHash("sha256");
    let off = 0;
    for (const r of rows) {
      const b = await this.store.get(r.storageKey);
      if (sha256Hex(b) !== r.sha256) throw new ForgeError("INTERNAL", `Stored chunk ${r.index} is corrupt`);
      if (off + b.byteLength > m.totalSize) throw new ForgeError("BAD_INPUT", "Chunks exceed declared total size");
      out.set(b, off);
      hash.update(b);
      off += b.byteLength;
    }
    if (off !== m.totalSize) throw new ForgeError("BAD_INPUT", `Assembled ${off} bytes, expected ${m.totalSize}`);
    const digest = hash.digest("hex");
    if (m.sha256 && m.sha256.toLowerCase() !== digest) throw new ForgeError("BAD_INPUT", "Whole-file checksum mismatch");
    const key = `${meetingPrefix(m.meetingId)}audio.${extensionForAudioMime(m.mimeType)}`;
    await this.store.put(key, out, { contentType: m.mimeType, region: "eu" });
    const done: Manifest = { ...m, completed: { key, size: off, sha256: digest, at: new Date().toISOString() } };
    await this.store.put(this.manifestKey(uploadId), JSON.stringify(done), { contentType: "application/json" });
    for (const r of rows) await this.store.delete(r.storageKey);
    return { key, size: off, sha256: digest };
  }
}
