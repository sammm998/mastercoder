import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { connect, runMigrations, secrets, workspaces, connections, eq, type DbHandle } from "@forge/db";
import { DrizzleMcpServerStore, DrizzleSecretStore, LocalKeyProvider, McpRegistry, Vault } from "../src/index.js";

let h: DbHandle;
const run = `t${Date.now().toString(36)}`;
const wsId = `ws_${run}`;

beforeAll(async () => {
  await runMigrations();
  h = connect();
  await h.db.insert(workspaces).values({ id: wsId, name: "Integrations int test" });
});
afterAll(async () => {
  await h.db.delete(secrets).where(eq(secrets.workspaceId, wsId));
  await h.db.delete(workspaces).where(eq(workspaces.id, wsId));
  await h.close();
});

describe("DrizzleSecretStore (Postgres)", () => {
  it("round-trips, scopes, upserts with NULL project and rotates", async () => {
    const store = new DrizzleSecretStore(h.db);
    const vault = new Vault(store, new LocalKeyProvider(randomBytes(32), `local:${run}-1`));
    await vault.put({ workspaceId: wsId, name: "WS_SECRET", value: "workspace-value-1" });
    await vault.put({ workspaceId: wsId, name: "WS_SECRET", value: "workspace-value-2" }); // upsert with NULL project
    await vault.put({ workspaceId: wsId, projectId: "prj_a", name: "WS_SECRET", value: "project-a-value" });
    await vault.put({ workspaceId: wsId, projectId: "prj_b", name: "ONLY_B", value: "project-b-value" });

    const rows = await h.db.select().from(secrets).where(eq(secrets.workspaceId, wsId));
    expect(rows).toHaveLength(3);
    expect(JSON.stringify(rows)).not.toContain("value-");

    expect(await vault.use({ workspaceId: wsId }, "WS_SECRET", (v) => v === "workspace-value-2")).toBe(true);
    expect(await vault.use({ workspaceId: wsId, projectId: "prj_a" }, "WS_SECRET", (v) => v === "project-a-value")).toBe(true);
    await expect(vault.use({ workspaceId: wsId, projectId: "prj_a" }, "ONLY_B", () => 1)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await vault.listNames({ workspaceId: wsId, projectId: "prj_b" })).toEqual(["ONLY_B"]);

    // tamper in the database: move project b's row into project a
    await h.db.update(secrets).set({ projectId: "prj_a", name: "MOVED" }).where(eq(secrets.name, "ONLY_B"));
    await expect(vault.use({ workspaceId: wsId, projectId: "prj_a" }, "MOVED", () => 1)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await h.db.update(secrets).set({ projectId: "prj_b", name: "ONLY_B" }).where(eq(secrets.name, "MOVED"));

    const next = new LocalKeyProvider(randomBytes(32), `local:${run}-2`);
    const before = await h.db.select().from(secrets).where(eq(secrets.workspaceId, wsId));
    const res = await vault.rotate(next, { workspaceId: wsId });
    expect(res.rotated).toBe(3);
    const after = await h.db.select().from(secrets).where(eq(secrets.workspaceId, wsId));
    expect(after.every((r) => r.keyId === next.keyId)).toBe(true);
    expect(after.map((r) => r.ciphertext).sort()).toEqual(before.map((r) => r.ciphertext).sort());
    const fresh = new Vault(store, next);
    expect(await fresh.use({ workspaceId: wsId, projectId: "prj_b" }, "ONLY_B", (v) => v === "project-b-value")).toBe(true);
    expect(await fresh.delete({ workspaceId: wsId, projectId: "prj_b" }, "ONLY_B")).toBe(true);
    expect(await fresh.listNames({ workspaceId: wsId, projectId: "prj_b" })).toEqual([]);
  });
});

describe("DrizzleMcpServerStore (Postgres)", () => {
  it("persists MCP servers in connections", async () => {
    const reg = new McpRegistry(new DrizzleMcpServerStore(h.db));
    await reg.add(wsId, { name: "linear", transport: "http", url: "https://8.8.8.8/mcp", headerSecrets: { Authorization: "LINEAR_TOKEN" } }, { userId: "usr_int" });
    await reg.add(wsId, { name: "linear", transport: "http", url: "https://8.8.4.4/mcp" }, { userId: "usr_int" }); // replace
    await reg.add(wsId, { name: "files", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"] }, { userId: "usr_int" });
    const list = await reg.list(wsId);
    expect(list.map((s) => [s.name, s.url ?? s.command])).toEqual([
      ["files", "npx"],
      ["linear", "https://8.8.4.4/mcp"],
    ]);
    const rows = await h.db.select().from(connections).where(eq(connections.workspaceId, wsId));
    expect(rows.filter((r) => r.provider === "mcp" && r.status === "active")).toHaveLength(2);
    expect(await reg.remove(wsId, "files")).toBe(true);
    expect((await reg.list(wsId)).map((s) => s.name)).toEqual(["linear"]);
  });
});
