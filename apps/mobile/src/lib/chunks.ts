import { z } from "zod";

/**
 * Resumable chunked upload of in-person meeting recordings:
 *   meetings.startRecording → PUT /uploads/:uploadId/:index (x-chunk-sha256, octet-stream) → meetings.uploadStatus
 *   (resume after restarts / network loss) → meetings.completeRecording.
 *
 * A finished recording is saved locally first (status "local", no server id yet), so a meeting that ends
 * offline is never lost; `run()` then creates the server upload, sends whatever the server is missing
 * (the server's uploadStatus is the source of truth) and completes. State is persisted after every chunk.
 * Every dependency is injected, so this runs in vitest.
 */

export interface ChunkSpan {
  index: number;
  start: number;
  /** Exclusive. */
  end: number;
}

export function chunkCount(totalSize: number, chunkSize: number): number {
  if (!(totalSize > 0) || !(chunkSize > 0)) return 0;
  return Math.ceil(totalSize / chunkSize);
}

export function planChunks(totalSize: number, chunkSize: number): ChunkSpan[] {
  const n = chunkCount(totalSize, chunkSize);
  return Array.from({ length: n }, (_, index) => ({ index, start: index * chunkSize, end: Math.min(totalSize, (index + 1) * chunkSize) }));
}

/** Indices not yet received, ascending. */
export function missingChunks(total: number, received: Iterable<number>): number[] {
  const have = new Set(received);
  const out: number[] = [];
  for (let i = 0; i < total; i++) if (!have.has(i)) out.push(i);
  return out;
}

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  return s;
}

/** Chunk size for phone uploads: small enough to retry cheaply on cellular, within the API's 64 KiB–16 MiB range. */
export const DEFAULT_CHUNK_SIZE = 2 * 1024 * 1024;

export const UploadStatusZ = z.enum(["local", "uploading", "completing", "done", "failed", "expired"]);
export type UploadStatus = z.infer<typeof UploadStatusZ>;

export const PendingUploadZ = z.object({
  version: z.literal(1),
  /** Stable local id (never changes, even when the server upload is recreated). */
  id: z.string().min(1),
  uploadId: z.string().min(1).optional(),
  meetingId: z.string().min(1).optional(),
  workspaceId: z.string().min(1),
  projectId: z.string().optional(),
  fileUri: z.string().min(1),
  totalSize: z.number().int().positive(),
  chunkSize: z.number().int().positive(),
  mimeType: z.string(),
  title: z.string(),
  language: z.enum(["sv", "en"]),
  durationMs: z.number().nonnegative().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Last known set of chunks the server has (refreshed from uploadStatus on every run). */
  received: z.array(z.number().int().nonnegative()),
  status: UploadStatusZ,
  error: z.string().optional(),
});
export type PendingUpload = z.infer<typeof PendingUploadZ>;

/** Parse persisted upload records, dropping anything malformed (e.g. from an older app version). */
export function parseStoredUploads(raw: string | null | undefined): PendingUpload[] {
  if (!raw) return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const out: PendingUpload[] = [];
  for (const item of v) {
    const r = PendingUploadZ.safeParse(item);
    if (r.success) out.push(r.data);
  }
  return out;
}

export interface UploadStore {
  list(): Promise<PendingUpload[]>;
  get(id: string): Promise<PendingUpload | null>;
  put(u: PendingUpload): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface AsyncKv {
  getItem(k: string): Promise<string | null>;
  setItem(k: string, v: string): Promise<void>;
}

/** Store backed by a single string key in any async key-value storage (AsyncStorage in the app). */
export class KeyValueUploadStore implements UploadStore {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly kv: AsyncKv,
    private readonly key = "forge.uploads.v1",
  ) {}
  async list() {
    await this.chain;
    return parseStoredUploads(await this.kv.getItem(this.key));
  }
  async get(id: string) {
    return (await this.list()).find((u) => u.id === id) ?? null;
  }
  put(u: PendingUpload) {
    return this.mutate((all) => [...all.filter((x) => x.id !== u.id), PendingUploadZ.parse(u)]);
  }
  remove(id: string) {
    return this.mutate((all) => all.filter((x) => x.id !== id));
  }
  /** Serialise read-modify-write so concurrent chunk completions don't lose updates. */
  private mutate(fn: (all: PendingUpload[]) => PendingUpload[]): Promise<void> {
    const next = this.chain.then(async () => {
      const all = parseStoredUploads(await this.kv.getItem(this.key));
      await this.kv.setItem(this.key, JSON.stringify(fn(all)));
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}

export class MemoryKv implements AsyncKv {
  readonly data = new Map<string, string>();
  async getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  async setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

/** HTTP-ish failure. status 0 = network error / no response. */
export class UploadHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "UploadHttpError";
  }
}

export class UploadAuthError extends Error {
  constructor() {
    super("Signed out: sign in again to continue the upload");
    this.name = "UploadAuthError";
  }
}

export class FileReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileReadError";
  }
}

export interface UploadApi {
  startRecording(input: { workspaceId: string; projectId?: string; title: string; language: "sv" | "en"; totalSize: number; mimeType: string; chunkSize: number }): Promise<{
    meetingId: string;
    uploadId: string;
    chunkSize: number;
  }>;
  uploadStatus(uploadId: string): Promise<{ received: number[]; missing: number[]; totalChunks: number }>;
  completeRecording(uploadId: string): Promise<{ ok: boolean; size: number }>;
  putChunk(uploadId: string, index: number, bytes: Uint8Array, sha256Hex: string, signal?: AbortSignal): Promise<void>;
}

export interface UploaderDeps {
  api: UploadApi;
  store: UploadStore;
  readChunk(fileUri: string, start: number, length: number): Promise<Uint8Array>;
  sha256Hex(bytes: Uint8Array): Promise<string>;
  newId(): string;
  sleep?(ms: number): Promise<void>;
  now?(): Date;
  /** Parallel chunk PUTs (default 2). */
  concurrency?: number;
  /** Retries per chunk for network/5xx/checksum errors before the run gives up (default 4). */
  maxRetries?: number;
  random?(): number;
}

export interface UploadProgress {
  id: string;
  receivedChunks: number;
  totalChunks: number;
  bytesSent: number;
  totalBytes: number;
  fraction: number;
  status: UploadStatus;
}

export function progressOf(u: PendingUpload): UploadProgress {
  const total = chunkCount(u.totalSize, u.chunkSize);
  const got = [...new Set(u.received)].filter((i) => i < total);
  const lastIdx = total - 1;
  const lastSize = u.totalSize - lastIdx * u.chunkSize;
  const bytes = Math.min(
    u.totalSize,
    got.reduce((sum, i) => sum + (i === lastIdx ? lastSize : u.chunkSize), 0),
  );
  return { id: u.id, receivedChunks: got.length, totalChunks: total, bytesSent: bytes, totalBytes: u.totalSize, fraction: u.status === "done" ? 1 : u.totalSize ? bytes / u.totalSize : 0, status: u.status };
}

/** Upload states the background resumer should pick up. */
export function isResumable(u: PendingUpload): boolean {
  return u.status === "local" || u.status === "uploading" || u.status === "completing";
}

const RETRYABLE = (e: unknown) => e instanceof UploadHttpError && (e.status === 0 || e.status === 400 || e.status === 408 || e.status === 429 || e.status >= 500);

class AbortErrorLike extends Error {
  constructor() {
    super("Upload paused");
    this.name = "AbortError";
  }
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

export interface RunOptions {
  onProgress?: (p: UploadProgress) => void;
  signal?: AbortSignal;
}

export class ResumableUploader {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly running = new Map<string, Promise<PendingUpload>>();

  constructor(private readonly d: UploaderDeps) {
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = d.now ?? (() => new Date());
  }

  /** Persist a finished recording locally. No network needed; `run()` uploads it. */
  async saveLocal(input: {
    fileUri: string;
    totalSize: number;
    mimeType: string;
    workspaceId: string;
    projectId?: string;
    title: string;
    language: "sv" | "en";
    durationMs?: number;
    chunkSize?: number;
  }): Promise<PendingUpload> {
    const ts = this.now().toISOString();
    const u: PendingUpload = {
      version: 1,
      id: this.d.newId(),
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      fileUri: input.fileUri,
      totalSize: input.totalSize,
      chunkSize: input.chunkSize ?? DEFAULT_CHUNK_SIZE,
      mimeType: input.mimeType,
      title: input.title,
      language: input.language,
      durationMs: input.durationMs,
      createdAt: ts,
      updatedAt: ts,
      received: [],
      status: "local",
    };
    await this.d.store.put(u);
    return u;
  }

  /** Create (or finish creating) the server upload, send missing chunks, complete. One run per id at a time. */
  run(id: string, opts: RunOptions = {}): Promise<PendingUpload> {
    const existing = this.running.get(id);
    if (existing) return existing;
    const p = this.doRun(id, opts).finally(() => this.running.delete(id));
    this.running.set(id, p);
    return p;
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  /** Resume every unfinished upload (app start, network regained, app foregrounded). Errors are per upload. */
  async resumeAll(opts: RunOptions = {}): Promise<Array<{ id: string; result?: PendingUpload; error?: unknown }>> {
    const todo = (await this.d.store.list()).filter(isResumable);
    const out: Array<{ id: string; result?: PendingUpload; error?: unknown }> = [];
    for (const u of todo) {
      try {
        out.push({ id: u.id, result: await this.run(u.id, opts) });
      } catch (error) {
        out.push({ id: u.id, error });
        if (error instanceof UploadAuthError || isAbortError(error)) break;
      }
    }
    return out;
  }

  /** The server forgot the upload (expired) or it failed: forget the server id and upload from scratch. */
  async restart(id: string, opts: RunOptions = {}): Promise<PendingUpload> {
    const u = await this.d.store.get(id);
    if (!u) throw new Error("Upload not found on this device");
    if (this.running.has(id)) throw new Error("Upload is already running");
    await this.update(u, { uploadId: undefined, meetingId: undefined, received: [], status: "local", error: undefined });
    return this.run(id, opts);
  }

  private async update(u: PendingUpload, patch: Partial<PendingUpload>): Promise<PendingUpload> {
    const next = { ...u, ...patch, updatedAt: this.now().toISOString() };
    await this.d.store.put(next);
    return next;
  }

  private async serverStatus(uploadId: string): Promise<{ received: number[]; totalChunks: number } | "expired"> {
    try {
      return await this.d.api.uploadStatus(uploadId);
    } catch (e) {
      if (e instanceof UploadHttpError && e.status === 404) return "expired";
      if (e instanceof UploadHttpError && e.status === 401) throw new UploadAuthError();
      throw e;
    }
  }

  private expired(u: PendingUpload) {
    return this.update(u, { status: "expired", error: "The server no longer has this upload" });
  }

  private async doRun(id: string, opts: RunOptions): Promise<PendingUpload> {
    let u = await this.d.store.get(id);
    if (!u) throw new Error(`Unknown upload ${id}`);
    if (u.status === "done" || u.status === "expired" || u.status === "failed") return u;
    const report = (x: PendingUpload) => opts.onProgress?.(progressOf(x));
    if (opts.signal?.aborted) throw new AbortErrorLike();

    if (!u.uploadId) {
      try {
        const r = await this.d.api.startRecording({
          workspaceId: u.workspaceId,
          projectId: u.projectId,
          title: u.title,
          language: u.language,
          totalSize: u.totalSize,
          mimeType: u.mimeType,
          chunkSize: u.chunkSize,
        });
        u = await this.update(u, { uploadId: r.uploadId, meetingId: r.meetingId, chunkSize: r.chunkSize, status: "uploading", received: [], error: undefined });
      } catch (e) {
        if (e instanceof UploadHttpError && e.status === 401) throw new UploadAuthError();
        if (e instanceof UploadHttpError && (e.status === 403 || e.status === 404)) return this.update(u, { status: "failed", error: e.message });
        await this.update(u, { error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    }
    const uploadId = u.uploadId as string;

    const st = await this.serverStatus(uploadId);
    if (st === "expired") return this.expired(u);
    const total = chunkCount(u.totalSize, u.chunkSize);
    if (st.totalChunks !== total) return this.update(u, { status: "failed", error: `Chunk plan mismatch (server ${st.totalChunks}, device ${total})` });
    u = await this.update(u, { received: [...new Set(st.received)].sort((a, b) => a - b), status: "uploading", error: undefined });
    report(u);

    const spans = planChunks(u.totalSize, u.chunkSize);
    const queue = missingChunks(total, u.received);
    const received = new Set(u.received);
    let fatal: unknown = null;
    let current = u;

    const worker = async () => {
      while (queue.length && !fatal) {
        if (opts.signal?.aborted) {
          fatal = new AbortErrorLike();
          return;
        }
        const index = queue.shift() as number;
        try {
          await this.sendChunk(current, uploadId, spans[index] as ChunkSpan, opts.signal);
        } catch (e) {
          fatal = e;
          return;
        }
        received.add(index);
        current = await this.update(current, { received: [...received].sort((a, b) => a - b) });
        report(current);
      }
    };
    const workers = Math.max(1, Math.min(this.d.concurrency ?? 2, queue.length || 1));
    await Promise.all(Array.from({ length: workers }, worker));

    if (fatal) {
      const err = fatal as unknown;
      if (err instanceof UploadHttpError && err.status === 404) return this.expired(current);
      if (err instanceof UploadHttpError && err.status === 403) return this.update(current, { status: "failed", error: "Not allowed to upload to this meeting" });
      if (err instanceof FileReadError) return this.update(current, { status: "failed", error: err.message });
      if (err instanceof UploadHttpError && err.status === 401) throw new UploadAuthError();
      if (!isAbortError(err)) await this.update(current, { error: err instanceof Error ? err.message : String(err) });
      throw err;
    }

    // Verify with the server before completing (a PUT may have been lost, or another run raced).
    const verify = await this.serverStatus(uploadId);
    if (verify === "expired") return this.expired(current);
    const stillMissing = missingChunks(total, verify.received);
    if (stillMissing.length) {
      await this.update(current, { received: verify.received, error: `Server is missing ${stillMissing.length} chunk(s)` });
      throw new UploadHttpError(0, `Server is still missing ${stillMissing.length} chunk(s); retry`);
    }

    current = await this.update(current, { status: "completing", received: verify.received });
    report(current);
    try {
      await this.d.api.completeRecording(uploadId);
    } catch (e) {
      if (e instanceof UploadHttpError && e.status === 404) return this.expired(current);
      if (e instanceof UploadHttpError && e.status === 401) throw new UploadAuthError();
      await this.update(current, { error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
    current = await this.update(current, { status: "done", error: undefined });
    report(current);
    return current;
  }

  private async sendChunk(u: PendingUpload, uploadId: string, span: ChunkSpan, signal?: AbortSignal): Promise<void> {
    const maxRetries = this.d.maxRetries ?? 4;
    for (let attempt = 0; ; attempt++) {
      let bytes: Uint8Array;
      try {
        bytes = await this.d.readChunk(u.fileUri, span.start, span.end - span.start);
      } catch (e) {
        throw new FileReadError(`Recording file unreadable: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (bytes.byteLength !== span.end - span.start) throw new FileReadError(`Recording file changed size (chunk ${span.index})`);
      // Hash per attempt: a 400 caused by a corrupted read is retried with freshly read bytes.
      const sha = await this.d.sha256Hex(bytes);
      try {
        await this.d.api.putChunk(uploadId, span.index, bytes, sha, signal);
        return;
      } catch (e) {
        if (signal?.aborted) throw new AbortErrorLike();
        if (!RETRYABLE(e) || attempt >= maxRetries) throw e;
        const base = 500 * 2 ** attempt;
        await this.sleep(Math.round(base / 2 + (this.d.random?.() ?? Math.random()) * base));
      }
    }
  }
}
