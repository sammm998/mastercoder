import { CryptoDigestAlgorithm, digest, randomUUID } from "expo-crypto";
import { File, FileMode } from "expo-file-system";
import { addNetworkStateListener } from "expo-network";
import { fetch as expoFetch } from "expo/fetch";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState, Platform } from "react-native";
import { errorCode, trpc, useSession } from "./api";
import { API_URL } from "./config";
import {
  KeyValueUploadStore,
  ResumableUploader,
  UploadAuthError,
  UploadHttpError,
  isAbortError,
  progressOf,
  toHex,
  type PendingUpload,
  type UploadApi,
  type UploadProgress,
} from "./lib/chunks";
import { kv } from "./storage";

const STATUS_BY_CODE: Record<string, number> = { NOT_FOUND: 404, UNAUTHORIZED: 401, FORBIDDEN: 403, BAD_REQUEST: 400, TOO_MANY_REQUESTS: 429, PRECONDITION_FAILED: 412 };

/** tRPC errors → UploadHttpError so the uploader can decide retry vs. give up. No code = network failure. */
async function mapErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const code = errorCode(e);
    throw new UploadHttpError(code ? (STATUS_BY_CODE[code] ?? 500) : 0, e instanceof Error ? e.message : String(e));
  }
}

/** Read `length` bytes at `start` without loading the whole (possibly hour-long) recording into memory. */
async function readChunk(uri: string, start: number, length: number): Promise<Uint8Array> {
  if (Platform.OS === "web") {
    const buf = await (await fetch(uri)).arrayBuffer();
    return new Uint8Array(buf.slice(start, start + length));
  }
  const handle = new File(uri).open(FileMode.ReadOnly);
  try {
    handle.offset = start;
    return await handle.readBytes(length);
  } finally {
    handle.close();
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(await digest(CryptoDigestAlgorithm.SHA256, bytes as Uint8Array<ArrayBuffer>));
}

function deleteLocalFile(uri: string) {
  if (Platform.OS === "web") return;
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    /* already gone */
  }
}

function pickRunning(cur: Record<string, UploadProgress>, list: PendingUpload[]): Record<string, UploadProgress> {
  const out: Record<string, UploadProgress> = {};
  for (const u of list) {
    const p = cur[u.id];
    if (p && p.receivedChunks > progressOf(u).receivedChunks) out[u.id] = p;
  }
  return out;
}

interface UploadsValue {
  uploads: PendingUpload[];
  progress: Record<string, UploadProgress>;
  authBlocked: boolean;
  saveRecording(input: Parameters<ResumableUploader["saveLocal"]>[0]): Promise<PendingUpload>;
  resume(id: string): void;
  restart(id: string): void;
  remove(id: string): Promise<void>;
}

const Ctx = createContext<UploadsValue | null>(null);

export function useUploads(): UploadsValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useUploads outside UploadsProvider");
  return v;
}

/**
 * Owns the ResumableUploader. Resumes unfinished uploads on launch, when the app returns to the foreground,
 * after sign-in and when the network comes back. JS does not run while the app is suspended, so uploads pause
 * in the background and continue on the next trigger (state is persisted after every chunk).
 */
export function UploadsProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const utils = trpc.useUtils();
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [progress, setProgress] = useState<Record<string, UploadProgress>>({});
  const [authBlocked, setAuthBlocked] = useState(false);
  const store = useMemo(() => new KeyValueUploadStore(kv), []);
  const getToken = session.getToken;

  const uploader = useMemo(() => {
    const api: UploadApi = {
      startRecording: (i) => mapErrors(() => utils.client.meetings.startRecording.mutate(i)),
      uploadStatus: (uploadId) => mapErrors(() => utils.client.meetings.uploadStatus.query({ uploadId })),
      completeRecording: (uploadId) => mapErrors(() => utils.client.meetings.completeRecording.mutate({ uploadId })),
      async putChunk(uploadId, index, bytes, sha, signal) {
        let res;
        try {
          res = await expoFetch(`${API_URL}/uploads/${encodeURIComponent(uploadId)}/${index}`, {
            method: "PUT",
            headers: { authorization: `Bearer ${getToken() ?? ""}`, "content-type": "application/octet-stream", "x-chunk-sha256": sha },
            body: bytes as Uint8Array<ArrayBuffer>,
            signal,
            credentials: "omit",
          });
        } catch (e) {
          throw new UploadHttpError(0, e instanceof Error ? e.message : String(e));
        }
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new UploadHttpError(res.status, body.error ?? `HTTP ${res.status}`);
        }
      },
    };
    return new ResumableUploader({ api, store, readChunk, sha256Hex, newId: () => `loc_${randomUUID()}`, concurrency: 2 });
  }, [store, utils, getToken]);

  const refresh = useCallback(async () => {
    const list = (await store.list()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    setUploads(list);
    // Seed progress from persisted state, keeping live progress that is ahead of it.
    setProgress((cur) => ({ ...Object.fromEntries(list.map((u) => [u.id, progressOf(u)])), ...pickRunning(cur, list) }));
    return list;
  }, [store]);
  const onProgress = useCallback((p: UploadProgress) => {
    setProgress((cur) => ({ ...cur, [p.id]: p }));
  }, []);

  const afterRun = useCallback(
    async (r: PendingUpload) => {
      if (r.status === "done") {
        deleteLocalFile(r.fileUri);
        void utils.meetings.list.invalidate();
      }
      await refresh();
    },
    [refresh, utils],
  );

  const handleError = useCallback(
    async (e: unknown) => {
      if (e instanceof UploadAuthError) setAuthBlocked(true);
      else if (!isAbortError(e)) console.warn("upload paused:", e instanceof Error ? e.message : e);
      await refresh();
    },
    [refresh],
  );

  const resumeAllRef = useRef<() => void>(() => undefined);
  resumeAllRef.current = () => {
    if (session.status !== "signedIn") return;
    void uploader
      .resumeAll({ onProgress })
      .then(async (results) => {
        for (const r of results) {
          if (r.result) await afterRun(r.result);
          else if (r.error) await handleError(r.error);
        }
      })
      .catch(handleError);
  };

  // Load persisted uploads, prune finished ones, and resume on sign-in.
  useEffect(() => {
    void (async () => {
      for (const u of await store.list()) if (u.status === "done") await store.remove(u.id);
      await refresh();
      if (session.status === "signedIn") {
        setAuthBlocked(false);
        resumeAllRef.current();
      }
    })();
  }, [store, refresh, session.status]);

  useEffect(() => {
    const app = AppState.addEventListener("change", (s) => {
      if (s === "active") resumeAllRef.current();
    });
    let net: { remove(): void } | null = null;
    try {
      net = addNetworkStateListener((st) => {
        if (st.isInternetReachable ?? st.isConnected) resumeAllRef.current();
      });
    } catch {
      net = null;
    }
    return () => {
      app.remove();
      net?.remove();
    };
  }, []);

  const runOne = useCallback(
    (id: string, how: "run" | "restart") => {
      const p = how === "run" ? uploader.run(id, { onProgress }) : uploader.restart(id, { onProgress });
      void refresh();
      p.then(afterRun, handleError);
    },
    [uploader, onProgress, afterRun, handleError, refresh],
  );

  const value = useMemo<UploadsValue>(
    () => ({
      uploads,
      progress,
      authBlocked,
      async saveRecording(input) {
        const u = await uploader.saveLocal(input);
        await refresh();
        runOne(u.id, "run");
        return u;
      },
      resume: (id) => runOne(id, "run"),
      restart: (id) => runOne(id, "restart"),
      async remove(id) {
        const u = await store.get(id);
        if (u) deleteLocalFile(u.fileUri);
        await store.remove(id);
        await refresh();
      },
    }),
    [uploads, progress, authBlocked, uploader, refresh, runOne, store],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
