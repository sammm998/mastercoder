/**
 * Recordings waiting to finish uploading, kept in IndexedDB so a reload or crash can resume the
 * chunked upload instead of losing the meeting. Only this browser can see them.
 */
export interface PendingUpload {
  uploadId: string;
  meetingId: string;
  chunkSize: number;
  title: string;
  mimeType: string;
  blob: Blob;
  createdAt: number;
}

const DB = "forge-uploads";
const STORE = "pending";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB unavailable"));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "uploadId" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const r = fn(db.transaction(STORE, mode).objectStore(STORE));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
    });
  } finally {
    db.close();
  }
}

export async function savePending(p: PendingUpload): Promise<void> {
  try {
    await tx("readwrite", (s) => s.put(p));
  } catch {
    /* best effort: the upload itself can still proceed */
  }
}

export async function listPending(): Promise<PendingUpload[]> {
  try {
    return await tx<PendingUpload[]>("readonly", (s) => s.getAll() as IDBRequest<PendingUpload[]>);
  } catch {
    return [];
  }
}

export async function removePending(uploadId: string): Promise<void> {
  try {
    await tx("readwrite", (s) => s.delete(uploadId));
  } catch {
    /* ignore */
  }
}
