import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { ForgeError, newId, selectAdapter } from "@forge/shared";
import { secrets as secretsTable, and, eq, isNull, type Db } from "@forge/db";
import { AwsKmsKeyProvider } from "./adapters/aws-kms.js";

export interface SecretScope {
  workspaceId: string;
  /** null/undefined = workspace-level secret. Project secrets are only visible in their own project scope. */
  projectId?: string | null;
}

/** Wraps/unwraps per-secret data encryption keys with a key-encryption key (KEK). */
export interface KeyProvider {
  readonly name: string;
  readonly keyId: string;
  wrap(dek: Buffer, context: Record<string, string>): Promise<string>;
  unwrap(wrapped: string, context: Record<string, string>): Promise<Buffer>;
}

export interface SecretRecord {
  id: string;
  workspaceId: string;
  projectId: string | null;
  name: string;
  ciphertext: string;
  iv: string;
  tag: string;
  wrappedDek: string;
  keyId: string;
  createdAt: Date;
}

export interface SecretStore {
  upsert(rec: SecretRecord): Promise<void>;
  /** Exact-scope lookup (workspace + project-or-null + name). */
  get(scope: SecretScope, name: string): Promise<SecretRecord | null>;
  list(scope: SecretScope): Promise<SecretRecord[]>;
  delete(scope: SecretScope, name: string): Promise<boolean>;
  /** Every record (rotation). */
  all(): Promise<SecretRecord[]>;
  updateWrapping(id: string, wrappedDek: string, keyId: string): Promise<void>;
}

function sortedContext(ctx: Record<string, string>): string {
  return JSON.stringify(Object.keys(ctx).sort().map((k) => [k, ctx[k]]));
}

function aesGcmEncrypt(key: Buffer, plaintext: Buffer, aad: Buffer): { iv: Buffer; tag: Buffer; ct: Buffer } {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return { iv, tag: c.getAuthTag(), ct };
}

function aesGcmDecrypt(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer, aad: Buffer): Buffer {
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

function parseKey(raw: string | Buffer): Buffer {
  if (Buffer.isBuffer(raw)) {
    if (raw.length !== 32) throw new ForgeError("BAD_INPUT", "Vault master key must be 32 bytes");
    return raw;
  }
  const s = raw.trim();
  const buf = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, "hex") : Buffer.from(s, "base64");
  if (buf.length !== 32) throw new ForgeError("BAD_INPUT", "VAULT_MASTER_KEY must be 32 bytes as hex (64 chars) or base64 (44 chars)");
  return buf;
}

/** KEK held in process memory from VAULT_MASTER_KEY (hex/base64). DEKs are wrapped with AES-256-GCM. */
export class LocalKeyProvider implements KeyProvider {
  readonly name: string = "local";
  readonly keyId: string;
  private readonly kek: Buffer;
  constructor(key: string | Buffer, keyId?: string) {
    this.kek = parseKey(key);
    this.keyId = keyId ?? `local:${createHash("sha256").update(this.kek).digest("hex").slice(0, 12)}`;
  }
  static fromEnv(): LocalKeyProvider {
    const k = process.env.VAULT_MASTER_KEY;
    if (!k) throw new ForgeError("BAD_INPUT", "VAULT_MASTER_KEY is not set");
    return new LocalKeyProvider(k, process.env.VAULT_KEY_ID || undefined);
  }
  async wrap(dek: Buffer, context: Record<string, string>): Promise<string> {
    const { iv, tag, ct } = aesGcmEncrypt(this.kek, dek, Buffer.from(`${this.keyId}|${sortedContext(context)}`));
    return `v1.${iv.toString("base64")}.${tag.toString("base64")}.${ct.toString("base64")}`;
  }
  async unwrap(wrapped: string, context: Record<string, string>): Promise<Buffer> {
    const [v, iv, tag, ct] = wrapped.split(".");
    if (v !== "v1" || !iv || !tag || !ct) throw new ForgeError("FORBIDDEN", "Malformed wrapped key");
    try {
      return aesGcmDecrypt(this.kek, Buffer.from(iv, "base64"), Buffer.from(tag, "base64"), Buffer.from(ct, "base64"), Buffer.from(`${this.keyId}|${sortedContext(context)}`));
    } catch {
      throw new ForgeError("FORBIDDEN", "Key unwrap failed (wrong key, wrong scope or tampered data)");
    }
  }
}

/** Ephemeral random KEK per process (VAULT_KEY_PROVIDER=mock): secrets do not survive a restart. Dev/tests only. */
export class MockKeyProvider extends LocalKeyProvider {
  override readonly name = "mock";
  constructor() {
    super(randomBytes(32), `mock:${newId("kek", 6)}`);
  }
}

/** VAULT_KEY_PROVIDER=kms|local|mock (default: local when VAULT_MASTER_KEY is set, else mock). */
export function createKeyProvider(): KeyProvider {
  return selectAdapter<KeyProvider>(
    "VAULT_KEY_PROVIDER",
    {
      kms: () => new AwsKmsKeyProvider({ keyId: process.env.VAULT_KMS_KEY_ID ?? "", region: process.env.AWS_REGION || "eu-central-1" }),
      local: () => LocalKeyProvider.fromEnv(),
      mock: () => new MockKeyProvider(),
    },
    process.env.VAULT_MASTER_KEY ? "local" : "mock",
  ).instance;
}

const NAME = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/, "secret name: letters, digits, _ . -, max 128");
const PutInput = z.object({ workspaceId: z.string().min(1), projectId: z.string().min(1).nullish(), name: NAME, value: z.string().min(1).max(65536) });

function aad(workspaceId: string, projectId: string | null, name: string): Buffer {
  return Buffer.from(`forge-vault:v1|${workspaceId}|${projectId ?? ""}|${name}`);
}

function context(workspaceId: string, projectId: string | null, name: string): Record<string, string> {
  return { forge_workspace: workspaceId, forge_project: projectId ?? "-", forge_secret: name };
}

/**
 * Envelope-encrypted secret vault. Each secret has a random 256-bit DEK (AES-256-GCM, AAD binds the
 * ciphertext to workspace/project/name so rows cannot be moved between scopes); the DEK is wrapped by the
 * KeyProvider's KEK with the same scope as context. Plaintext is only available inside `use()` callbacks.
 */
export class Vault {
  private current: KeyProvider;
  private readonly byKeyId = new Map<string, KeyProvider>();

  constructor(
    private readonly store: SecretStore,
    keyProvider: KeyProvider,
    opts: { previousKeyProviders?: KeyProvider[] } = {},
  ) {
    this.current = keyProvider;
    for (const k of [...(opts.previousKeyProviders ?? []), keyProvider]) this.byKeyId.set(k.keyId, k);
  }

  get keyId(): string {
    return this.current.keyId;
  }

  async put(input: { workspaceId: string; projectId?: string | null; name: string; value: string }): Promise<{ id: string; name: string; keyId: string }> {
    const p = PutInput.safeParse(input);
    if (!p.success) throw new ForgeError("BAD_INPUT", `Invalid secret: ${p.error.issues.map((i) => i.message).join("; ")}`);
    const projectId = p.data.projectId ?? null;
    const dek = randomBytes(32);
    try {
      const { iv, tag, ct } = aesGcmEncrypt(dek, Buffer.from(p.data.value, "utf8"), aad(p.data.workspaceId, projectId, p.data.name));
      const wrappedDek = await this.current.wrap(dek, context(p.data.workspaceId, projectId, p.data.name));
      const existing = await this.store.get({ workspaceId: p.data.workspaceId, projectId }, p.data.name);
      const rec: SecretRecord = {
        id: existing?.id ?? newId("sec"),
        workspaceId: p.data.workspaceId,
        projectId,
        name: p.data.name,
        ciphertext: ct.toString("base64"),
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
        wrappedDek,
        keyId: this.current.keyId,
        createdAt: new Date(),
      };
      await this.store.upsert(rec);
      return { id: rec.id, name: rec.name, keyId: rec.keyId };
    } finally {
      dek.fill(0);
    }
  }

  /**
   * Lend the plaintext to `fn`. The return value must not contain the secret (it would leak into API
   * responses / logs): such results are rejected with FORBIDDEN.
   */
  async use<T>(scope: SecretScope, name: string, fn: (plaintext: string) => Promise<T> | T): Promise<T> {
    const projectId = scope.projectId ?? null;
    const rec = await this.store.get({ workspaceId: scope.workspaceId, projectId }, name);
    if (!rec || rec.workspaceId !== scope.workspaceId || rec.projectId !== projectId) throw new ForgeError("NOT_FOUND", `Secret "${name}" not found in this scope`);
    const kp = this.byKeyId.get(rec.keyId);
    if (!kp) throw new ForgeError("INTERNAL", `No key provider for key id ${rec.keyId}`);
    const dek = await kp.unwrap(rec.wrappedDek, context(rec.workspaceId, rec.projectId, rec.name));
    let plaintext: string;
    try {
      plaintext = aesGcmDecrypt(dek, Buffer.from(rec.iv, "base64"), Buffer.from(rec.tag, "base64"), Buffer.from(rec.ciphertext, "base64"), aad(rec.workspaceId, rec.projectId, rec.name)).toString("utf8");
    } catch {
      throw new ForgeError("FORBIDDEN", `Secret "${name}" failed integrity check (tampered or moved between scopes)`);
    } finally {
      dek.fill(0);
    }
    const result = await fn(plaintext);
    if (plaintext.length >= 4 && result !== undefined && result !== null) {
      let serialized = "";
      try {
        serialized = typeof result === "string" ? result : JSON.stringify(result) ?? "";
      } catch {
        serialized = "";
      }
      if (serialized.includes(plaintext)) throw new ForgeError("FORBIDDEN", `Vault.use callback returned the plaintext of "${name}"`);
    }
    return result;
  }

  async listNames(scope: SecretScope): Promise<string[]> {
    return (await this.store.list({ workspaceId: scope.workspaceId, projectId: scope.projectId ?? null })).map((r) => r.name).sort();
  }

  async has(scope: SecretScope, name: string): Promise<boolean> {
    return (await this.store.get({ workspaceId: scope.workspaceId, projectId: scope.projectId ?? null }, name)) !== null;
  }

  async delete(scope: SecretScope, name: string): Promise<boolean> {
    return this.store.delete({ workspaceId: scope.workspaceId, projectId: scope.projectId ?? null }, name);
  }

  /**
   * Re-wrap every DEK with `next` (ciphertexts untouched). Old providers stay registered for in-flight reads.
   * `workspaceId` limits rotation to one tenant (e.g. moving an enterprise workspace to its own KMS key).
   */
  async rotate(next: KeyProvider, opts: { workspaceId?: string } = {}): Promise<{ rotated: number; keyId: string }> {
    this.byKeyId.set(next.keyId, next);
    let rotated = 0;
    for (const rec of await this.store.all()) {
      if (rec.keyId === next.keyId || (opts.workspaceId && rec.workspaceId !== opts.workspaceId)) continue;
      const old = this.byKeyId.get(rec.keyId);
      if (!old) throw new ForgeError("INTERNAL", `Cannot rotate secret ${rec.id}: unknown key id ${rec.keyId}`);
      const ctx = context(rec.workspaceId, rec.projectId, rec.name);
      const dek = await old.unwrap(rec.wrappedDek, ctx);
      try {
        await this.store.updateWrapping(rec.id, await next.wrap(dek, ctx), next.keyId);
      } finally {
        dek.fill(0);
      }
      rotated++;
    }
    if (!opts.workspaceId) this.current = next;
    return { rotated, keyId: next.keyId };
  }
}

export class MemorySecretStore implements SecretStore {
  private readonly rows = new Map<string, SecretRecord>();
  private k(scope: SecretScope, name: string): string {
    return JSON.stringify([scope.workspaceId, scope.projectId ?? null, name]);
  }
  async upsert(rec: SecretRecord): Promise<void> {
    this.rows.set(this.k(rec, rec.name), { ...rec });
  }
  async get(scope: SecretScope, name: string): Promise<SecretRecord | null> {
    const r = this.rows.get(this.k(scope, name));
    return r ? { ...r } : null;
  }
  async list(scope: SecretScope): Promise<SecretRecord[]> {
    return [...this.rows.values()].filter((r) => r.workspaceId === scope.workspaceId && r.projectId === (scope.projectId ?? null)).map((r) => ({ ...r }));
  }
  async delete(scope: SecretScope, name: string): Promise<boolean> {
    return this.rows.delete(this.k(scope, name));
  }
  async all(): Promise<SecretRecord[]> {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
  async updateWrapping(id: string, wrappedDek: string, keyId: string): Promise<void> {
    for (const r of this.rows.values()) if (r.id === id) Object.assign(r, { wrappedDek, keyId });
  }
  /** Test helper: raw access to stored rows (to simulate database tampering). */
  raw(): SecretRecord[] {
    return [...this.rows.values()];
  }
}

/** SecretStore on the `secrets` table of @forge/db. */
export class DrizzleSecretStore implements SecretStore {
  constructor(private readonly db: Db) {}
  private where(scope: SecretScope, name?: string) {
    const proj = scope.projectId ? eq(secretsTable.projectId, scope.projectId) : isNull(secretsTable.projectId);
    const base = and(eq(secretsTable.workspaceId, scope.workspaceId), proj);
    return name === undefined ? base : and(base, eq(secretsTable.name, name));
  }
  async upsert(rec: SecretRecord): Promise<void> {
    // NULL project ids are distinct in the unique index, so upsert by explicit delete+insert in one transaction.
    await this.db.transaction(async (tx) => {
      await tx.delete(secretsTable).where(this.where(rec, rec.name));
      await tx.insert(secretsTable).values(rec);
    });
  }
  async get(scope: SecretScope, name: string): Promise<SecretRecord | null> {
    const [r] = await this.db.select().from(secretsTable).where(this.where(scope, name)).limit(1);
    return r ?? null;
  }
  async list(scope: SecretScope): Promise<SecretRecord[]> {
    return this.db.select().from(secretsTable).where(this.where(scope));
  }
  async delete(scope: SecretScope, name: string): Promise<boolean> {
    const r = await this.db.delete(secretsTable).where(this.where(scope, name)).returning({ id: secretsTable.id });
    return r.length > 0;
  }
  async all(): Promise<SecretRecord[]> {
    return this.db.select().from(secretsTable);
  }
  async updateWrapping(id: string, wrappedDek: string, keyId: string): Promise<void> {
    await this.db.update(secretsTable).set({ wrappedDek, keyId }).where(eq(secretsTable.id, id));
  }
}
