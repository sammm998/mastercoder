import { createHmac, timingSafeEqual } from "node:crypto";
import { eq, like } from "drizzle-orm";
import type { ObjectStore, PutOptions } from "@forge/shared";
import type { Db } from "./client.js";
import { storedObjects } from "./schema.js";

function safeKey(key: string): string {
  if (!key || key.includes("..") || key.startsWith("/")) throw new Error(`Invalid storage key: ${key}`);
  return key;
}

const sign = (key: string, exp: number, secret: string) => createHmac("sha256", secret).update(`${key}\n${exp}`).digest("base64url");

/** Verify a signed /files URL (key, exp, sig). */
export function verifyFileSignature(key: string, exp: number, sig: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!Number.isFinite(exp) || exp < nowSec) return false;
  const want = Buffer.from(sign(key, exp, secret));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * Postgres-backed object store: api and worker share it without an S3 bucket. URLs point at the API's
 * /files route and are HMAC-signed with an expiry (AUTH_SECRET).
 */
export class DbObjectStore implements ObjectStore {
  readonly name = "db";
  constructor(
    private readonly db: Db,
    private readonly o: { publicBaseUrl: string; secret: string },
  ) {}

  async put(key: string, body: Uint8Array | string, opts: PutOptions = {}) {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    const row = { key: safeKey(key), contentType: opts.contentType ?? "application/octet-stream", size: bytes.length, body: bytes };
    await this.db.insert(storedObjects).values(row).onConflictDoUpdate({ target: storedObjects.key, set: { contentType: row.contentType, size: row.size, body: row.body } });
    return { key, size: bytes.length };
  }
  async get(key: string) {
    const [r] = await this.db.select().from(storedObjects).where(eq(storedObjects.key, safeKey(key)));
    if (!r) throw new Error(`Object not found: ${key}`);
    return r.body;
  }
  async head(key: string) {
    const [r] = await this.db.select({ contentType: storedObjects.contentType, size: storedObjects.size }).from(storedObjects).where(eq(storedObjects.key, safeKey(key)));
    return r ?? null;
  }
  async delete(key: string) {
    await this.db.delete(storedObjects).where(eq(storedObjects.key, safeKey(key)));
  }
  async exists(key: string) {
    return !!(await this.head(key));
  }
  async list(prefix: string) {
    const rows = await this.db.select({ key: storedObjects.key }).from(storedObjects).where(like(storedObjects.key, `${prefix.replace(/[%_]/g, "\\$&")}%`));
    return rows.map((r) => r.key);
  }
  async url(key: string, expiresSec = 7 * 24 * 3600) {
    const exp = Math.floor(Date.now() / 1000) + expiresSec;
    return `${this.o.publicBaseUrl.replace(/\/$/, "")}/files/${safeKey(key).split("/").map(encodeURIComponent).join("/")}?exp=${exp}&sig=${sign(key, exp, this.o.secret)}`;
  }
}
