import { mkdir, readFile, writeFile, rm, stat, readdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export interface PutOptions {
  contentType?: string;
  /** Data residency tag; Forge stores everything in EU regions. */
  region?: string;
}

/** S3-compatible object storage abstraction. */
export interface ObjectStore {
  readonly name: string;
  put(key: string, body: Uint8Array | string, opts?: PutOptions): Promise<{ key: string; size: number }>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
  /** Signed (or local) URL for reading the object. */
  url(key: string, expiresSec?: number): Promise<string>;
}

function safeKey(key: string): string {
  if (key.includes("..") || key.startsWith("/")) throw new Error(`Invalid storage key: ${key}`);
  return key;
}

/** Real filesystem-backed object store (dev + self-hosted single node). */
export class LocalObjectStore implements ObjectStore {
  readonly name = "local";
  private readonly root: string;
  constructor(root: string, private readonly publicBaseUrl = "file://") {
    this.root = resolve(root);
  }
  private path(key: string): string {
    const p = resolve(join(this.root, safeKey(key)));
    if (!p.startsWith(this.root + sep) && p !== this.root) throw new Error("Path escape");
    return p;
  }
  async put(key: string, body: Uint8Array | string): Promise<{ key: string; size: number }> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    const buf = typeof body === "string" ? Buffer.from(body) : Buffer.from(body);
    await writeFile(p, buf);
    return { key, size: buf.byteLength };
  }
  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.path(key)));
  }
  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.path(key));
      return true;
    } catch {
      return false;
    }
  }
  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(join(dir, e.name), r);
        else if (r.startsWith(prefix)) out.push(r);
      }
    };
    await walk(this.root, "");
    return out.sort();
  }
  async url(key: string): Promise<string> {
    return this.publicBaseUrl === "file://" ? `file://${this.path(key)}` : `${this.publicBaseUrl}/${safeKey(key)}`;
  }
}
