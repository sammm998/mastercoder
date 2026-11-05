import { describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";

const kms = vi.hoisted(() => ({ sent: [] as Array<{ name: string; input: Record<string, unknown> }> }));
vi.mock("@aws-sdk/client-kms", () => {
  // Fake KMS: "encrypts" by XOR with a fixed pad and binds the encryption context, like the real service.
  const pad = Buffer.alloc(32, 0x5a);
  const bind = (ctx: unknown) => Buffer.from(JSON.stringify(ctx ?? {})).toString("base64");
  class EncryptCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class DecryptCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class KMSClient {
    constructor(public config: Record<string, unknown>) {}
    async send(cmd: EncryptCommand | DecryptCommand) {
      kms.sent.push({ name: cmd.constructor.name, input: cmd.input });
      if (cmd instanceof EncryptCommand) {
        const pt = Buffer.from(cmd.input.Plaintext as Uint8Array);
        const ct = Buffer.from(pt.map((b, i) => b ^ pad[i % 32]!));
        return { CiphertextBlob: new Uint8Array(Buffer.from(`${bind(cmd.input.EncryptionContext)}.${ct.toString("base64")}`)) };
      }
      const [ctx, ct] = Buffer.from(cmd.input.CiphertextBlob as Uint8Array).toString().split(".");
      if (ctx !== bind(cmd.input.EncryptionContext)) throw Object.assign(new Error("context mismatch"), { name: "InvalidCiphertextException" });
      const raw = Buffer.from(ct!, "base64");
      return { Plaintext: new Uint8Array(raw.map((b, i) => b ^ pad[i % 32]!)) };
    }
  }
  return { KMSClient, EncryptCommand, DecryptCommand };
});

import { AwsKmsKeyProvider, LocalKeyProvider, MemorySecretStore, MockKeyProvider, Vault, createKeyProvider, vaultAuth, callOperation, parseOpenApiDocument } from "../src/index.js";

const ws = { workspaceId: "ws_1" };
const projA = { workspaceId: "ws_1", projectId: "prj_a" };
const projB = { workspaceId: "ws_1", projectId: "prj_b" };

function setup() {
  const store = new MemorySecretStore();
  const key = new LocalKeyProvider(randomBytes(32).toString("hex"), "local:test-1");
  return { store, key, vault: new Vault(store, key) };
}

describe("Vault", () => {
  it("round-trips secrets; plaintext only inside use()", async () => {
    const { vault, store } = setup();
    const r = await vault.put({ ...projA, name: "HUBSPOT_TOKEN", value: "pat-eu1-abcdef123456" });
    expect(r).toEqual({ id: expect.stringMatching(/^sec_/), name: "HUBSPOT_TOKEN", keyId: "local:test-1" });
    expect(JSON.stringify(r)).not.toContain("pat-eu1");
    expect(JSON.stringify(store.raw())).not.toContain("pat-eu1");
    const len = await vault.use(projA, "HUBSPOT_TOKEN", (v) => v.length);
    expect(len).toBe(20);
    expect(await vault.listNames(projA)).toEqual(["HUBSPOT_TOKEN"]);
    // overwrite keeps the id
    const r2 = await vault.put({ ...projA, name: "HUBSPOT_TOKEN", value: "pat-eu1-rotated-000" });
    expect(r2.id).toBe(r.id);
    expect(await vault.use(projA, "HUBSPOT_TOKEN", (v) => v.endsWith("000"))).toBe(true);
  });

  it("refuses to return plaintext from use()", async () => {
    const { vault } = setup();
    await vault.put({ ...ws, name: "API_KEY", value: "sk_live_supersecret" });
    await expect(vault.use(ws, "API_KEY", (v) => v)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(vault.use(ws, "API_KEY", (v) => ({ headers: { authorization: `Bearer ${v}` } }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await vault.use(ws, "API_KEY", () => ({ ok: true }))).toEqual({ ok: true });
  });

  it("enforces scope: projects and workspaces are separate", async () => {
    const { vault } = setup();
    await vault.put({ ...projA, name: "DB_URL", value: "postgres://a" });
    await vault.put({ ...ws, name: "SHARED", value: "workspace-level" });
    await expect(vault.use(projB, "DB_URL", () => 1)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(vault.use(ws, "DB_URL", () => 1)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(vault.use({ workspaceId: "ws_2", projectId: "prj_a" }, "DB_URL", () => 1)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(vault.use(projA, "SHARED", () => 1)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await vault.listNames(projB)).toEqual([]);
    expect(await vault.listNames(ws)).toEqual(["SHARED"]);
    expect(await vault.delete(projB, "DB_URL")).toBe(false);
    expect(await vault.delete(projA, "DB_URL")).toBe(true);
    expect(await vault.has(projA, "DB_URL")).toBe(false);
  });

  it("detects tampering and rows moved between scopes", async () => {
    const { vault, store } = setup();
    await vault.put({ ...projA, name: "TOKEN", value: "value-in-project-a" });
    await vault.put({ ...projB, name: "TOKEN", value: "value-in-project-b" });
    const [a, b] = store.raw();
    // flip one ciphertext bit
    const ct = Buffer.from(a!.ciphertext, "base64");
    ct[0] = ct[0]! ^ 1;
    a!.ciphertext = ct.toString("base64");
    await expect(vault.use(projA, "TOKEN", () => 1)).rejects.toThrow(/integrity/);
    // swap B's encrypted payload into A's row (attacker with DB write access)
    Object.assign(a!, { ciphertext: b!.ciphertext, iv: b!.iv, tag: b!.tag, wrappedDek: b!.wrappedDek });
    await expect(vault.use(projA, "TOKEN", () => 1)).rejects.toMatchObject({ code: "FORBIDDEN" });
    // tampered auth tag
    await vault.put({ ...ws, name: "T2", value: "abcdefgh" });
    const t2 = store.raw().find((r) => r.name === "T2")!;
    t2.tag = Buffer.alloc(16).toString("base64");
    await expect(vault.use(ws, "T2", () => 1)).rejects.toThrow(/integrity/);
  });

  it("rejects decryption with the wrong master key", async () => {
    const { store, vault } = setup();
    await vault.put({ ...ws, name: "X", value: "secret-x-value" });
    const other = new Vault(store, new LocalKeyProvider(randomBytes(32), "local:test-1"));
    await expect(other.use(ws, "X", () => 1)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rotates the KEK by re-wrapping DEKs", async () => {
    const { vault, store } = setup();
    await vault.put({ ...ws, name: "A", value: "alpha-secret" });
    await vault.put({ ...projA, name: "B", value: "bravo-secret" });
    const before = store.raw().map((r) => ({ ct: r.ciphertext, dek: r.wrappedDek }));
    const next = new LocalKeyProvider(randomBytes(32), "local:test-2");
    expect(await vault.rotate(next)).toEqual({ rotated: 2, keyId: "local:test-2" });
    const after = store.raw();
    expect(after.every((r) => r.keyId === "local:test-2")).toBe(true);
    expect(after.map((r) => r.ciphertext)).toEqual(before.map((b) => b.ct));
    expect(after.map((r) => r.wrappedDek)).not.toEqual(before.map((b) => b.dek));
    // a fresh vault with only the new key can read everything
    const fresh = new Vault(store, next);
    expect(await fresh.use(ws, "A", (v) => v === "alpha-secret")).toBe(true);
    expect(await fresh.use(projA, "B", (v) => v === "bravo-secret")).toBe(true);
    expect((await vault.put({ ...ws, name: "C", value: "charlie" })).keyId).toBe("local:test-2");
    expect(await vault.rotate(next)).toEqual({ rotated: 0, keyId: "local:test-2" });
  });

  it("validates input and master key format", async () => {
    const { vault } = setup();
    await expect(vault.put({ ...ws, name: "bad name", value: "x" })).rejects.toMatchObject({ code: "BAD_INPUT" });
    await expect(vault.put({ ...ws, name: "EMPTY", value: "" })).rejects.toMatchObject({ code: "BAD_INPUT" });
    expect(() => new LocalKeyProvider("too-short")).toThrow(/32 bytes/);
    expect(new LocalKeyProvider(randomBytes(32).toString("base64")).keyId).toMatch(/^local:[0-9a-f]{12}$/);
  });

  it("works with AWS KMS as KEK (EncryptionContext bound)", async () => {
    kms.sent.length = 0;
    const store = new MemorySecretStore();
    const kp = new AwsKmsKeyProvider({ keyId: "arn:aws:kms:eu-central-1:111122223333:key/test" });
    const vault = new Vault(store, kp);
    await vault.put({ ...projA, name: "STRIPE_KEY", value: "sk_test_kms_value" });
    expect(kms.sent[0]).toMatchObject({ name: "EncryptCommand", input: { KeyId: "arn:aws:kms:eu-central-1:111122223333:key/test", EncryptionContext: { forge_workspace: "ws_1", forge_project: "prj_a", forge_secret: "STRIPE_KEY" } } });
    expect((kms.sent[0]!.input.Plaintext as Uint8Array).length).toBe(32);
    expect(await vault.use(projA, "STRIPE_KEY", (v) => v.length)).toBe(17);
    expect(kms.sent[1]!.name).toBe("DecryptCommand");
    // moving the row to another project breaks the KMS encryption context
    const row = store.raw()[0]!;
    row.projectId = "prj_b";
    await store.upsert(row);
    await expect(vault.use(projB, "STRIPE_KEY", () => 1)).rejects.toMatchObject({ code: "FORBIDDEN" });
    // rotate from KMS to a local key
    const local = new LocalKeyProvider(randomBytes(32), "local:after-kms");
    await vault.put({ ...ws, name: "W", value: "workspace-secret" });
    const res = await new Vault(store, kp).rotate(local).catch((e: Error) => e);
    expect(res).toBeInstanceOf(Error); // the tampered row cannot be unwrapped -> rotation stops loudly
  });

  it("selects key providers by env", () => {
    const prev = { p: process.env.VAULT_KEY_PROVIDER, k: process.env.VAULT_MASTER_KEY };
    delete process.env.VAULT_KEY_PROVIDER;
    delete process.env.VAULT_MASTER_KEY;
    expect(createKeyProvider()).toBeInstanceOf(MockKeyProvider);
    process.env.VAULT_MASTER_KEY = randomBytes(32).toString("hex");
    expect(createKeyProvider().name).toBe("local");
    process.env.VAULT_KEY_PROVIDER = "kms";
    expect(() => createKeyProvider()).toThrow(/VAULT_KMS_KEY_ID/);
    for (const [k, v] of [["VAULT_KEY_PROVIDER", prev.p], ["VAULT_MASTER_KEY", prev.k]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("lends credentials to OpenAPI calls via vaultAuth", async () => {
    const { vault } = setup();
    await vault.put({ ...projA, name: "WEATHER_KEY", value: "wk_from_vault_42" });
    const api = parseOpenApiDocument({ openapi: "3.1.0", info: { title: "W", version: "1" }, servers: [{ url: "https://api.example.com" }], paths: { "/x": { get: { operationId: "x", responses: { "200": { description: "ok" } } } } } });
    let seen = "";
    const fetchStub = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      seen = new Headers(init?.headers).get("x-api-key") ?? "";
      return new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const auth = vaultAuth(vault, projA, "WEATHER_KEY", (k) => ({ type: "apiKey", in: "header", name: "X-API-Key", value: k }));
    const r = await callOperation(api, "x", {}, auth, { fetch: fetchStub });
    expect(r.data).toEqual({ ok: true });
    expect(seen).toBe("wk_from_vault_42");
    await expect(callOperation(api, "x", {}, vaultAuth(vault, projB, "WEATHER_KEY", (k) => ({ type: "bearer", token: k })), { fetch: fetchStub })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
