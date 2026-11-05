/**
 * Resumable chunked uploads (meeting recordings). The server tracks which chunk indexes it has
 * (`meetings.uploadStatus`); every PUT carries the chunk's SHA-256 so corrupted chunks are rejected
 * and re-sent. Re-running `uploadChunks` after a crash or network loss only sends what's missing.
 */

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const view = data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", view as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function chunkCount(totalSize: number, chunkSize: number): number {
  if (chunkSize <= 0) throw new Error("chunkSize must be positive");
  return Math.max(1, Math.ceil(totalSize / chunkSize));
}

export function chunkRange(index: number, chunkSize: number, totalSize: number): [number, number] {
  const start = index * chunkSize;
  return [start, Math.min(totalSize, start + chunkSize)];
}

export interface UploadStatus {
  received: number[];
  missing: number[];
  totalChunks: number;
}

export interface ChunkTransport {
  putChunk(index: number, bytes: Uint8Array, sha256: string, signal?: AbortSignal): Promise<void>;
  status(): Promise<UploadStatus>;
}

export class ChunkUploadError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ChunkUploadError";
  }
}

export interface UploadOptions {
  chunkSize: number;
  concurrency?: number;
  retries?: number;
  /** Base delay for exponential backoff between retries. */
  backoffMs?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Upload every chunk the server is missing; resolves when the server reports none missing. */
export async function uploadChunks(blob: Blob, transport: ChunkTransport, opts: UploadOptions): Promise<UploadStatus> {
  const { chunkSize, concurrency = 3, retries = 4, backoffMs = 400, signal, onProgress, sleep = defaultSleep } = opts;
  const total = chunkCount(blob.size, chunkSize);
  for (let pass = 0; pass < 3; pass++) {
    const status = await transport.status();
    const missing = status.missing.length || status.received.length ? status.missing : Array.from({ length: total }, (_, i) => i);
    let done = total - missing.length;
    onProgress?.(done, total);
    if (missing.length === 0) return status;
    const queue = [...missing];
    const worker = async () => {
      for (;;) {
        const index = queue.shift();
        if (index === undefined) return;
        const [start, end] = chunkRange(index, chunkSize, blob.size);
        const bytes = new Uint8Array(await blob.slice(start, end).arrayBuffer());
        const sha = await sha256Hex(bytes);
        for (let attempt = 0; ; attempt++) {
          if (signal?.aborted) throw new DOMException("Upload aborted", "AbortError");
          try {
            await transport.putChunk(index, bytes, sha, signal);
            break;
          } catch (e) {
            const status = e instanceof ChunkUploadError ? e.status : undefined;
            // 4xx other than 408/429 won't succeed on retry (bad hash is re-sent on the next pass).
            const fatal = status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
            if (fatal || attempt >= retries) throw e;
            await sleep(backoffMs * 2 ** attempt);
          }
        }
        done++;
        onProgress?.(done, total);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, missing.length) }, worker));
  }
  const final = await transport.status();
  if (final.missing.length) throw new ChunkUploadError(`Server still missing ${final.missing.length} chunk(s)`);
  return final;
}

/** Transport for PUT ${api}/uploads/:uploadId/:index (cookie-authenticated). */
export function httpTransport(opts: { apiUrl: string; uploadId: string; status: () => Promise<UploadStatus>; fetchImpl?: typeof fetch }): ChunkTransport {
  const f = opts.fetchImpl ?? fetch;
  return {
    status: opts.status,
    async putChunk(index, bytes, sha256, signal) {
      let res: Response;
      try {
        res = await f(`${opts.apiUrl}/uploads/${encodeURIComponent(opts.uploadId)}/${index}`, {
          method: "PUT",
          credentials: "include",
          headers: { "content-type": "application/octet-stream", "x-chunk-sha256": sha256 },
          body: bytes as Uint8Array<ArrayBuffer>,
          signal,
        });
      } catch (e) {
        throw new ChunkUploadError((e as Error).message);
      }
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          msg = ((await res.json()) as { error?: string }).error ?? msg;
        } catch {
          /* not JSON */
        }
        throw new ChunkUploadError(msg, res.status);
      }
    },
  };
}
