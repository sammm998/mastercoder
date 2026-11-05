import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { runTool, toToolDef } from "@forge/llm";
import { McpRegistry, MemorySecretStore, MockKeyProvider, Vault, mcpTools, mcpToolIrreversible, openMcpTools } from "../src/index.js";
import { buildServer } from "./fixtures/mcp-server.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));
const stdio = { name: "fixture", transport: "stdio" as const, command: process.execPath, args: [FIXTURE] };

describe("MCP over stdio (official SDK)", () => {
  it("lists and calls tools, mapping annotations to irreversible", async () => {
    const tools = await mcpTools(stdio);
    expect(tools.map((t) => t.name).sort()).toEqual(["mcp_fixture_add", "mcp_fixture_delete_note", "mcp_fixture_get_note", "mcp_fixture_whoami"]);
    expect(tools.find((t) => t.name === "mcp_fixture_delete_note")!.irreversible).toBe(true);
    expect(tools.find((t) => t.name === "mcp_fixture_add")!.irreversible).toBe(false);
    expect(toToolDef(tools.find((t) => t.name === "mcp_fixture_add")!).inputSchema).toMatchObject({ type: "object", required: ["a", "b"] });
    expect(await runTool(tools, "mcp_fixture_add", { a: 2, b: 40 }, {})).toEqual({ ok: true, output: "42" });
    expect(await runTool(tools, "mcp_fixture_get_note", { id: "n1" }, {})).toEqual({ ok: true, output: JSON.stringify({ id: "n1", text: "first note" }) });
    const missing = await runTool(tools, "mcp_fixture_get_note", { id: "zz" }, {});
    expect(missing.ok).toBe(false);
    expect(missing.output).toMatch(/not found/);
    expect((await runTool(tools, "mcp_fixture_add", { a: "x" }, {})).ok).toBe(false);
  }, 30_000);

  it("keeps one session open with openMcpTools", async () => {
    const { tools, close } = await openMcpTools(stdio);
    try {
      expect((await runTool(tools, "mcp_fixture_delete_note", { id: "n1" }, {})).output).toBe("deleted");
      expect((await runTool(tools, "mcp_fixture_delete_note", { id: "n1" }, {})).output).toBe("missing"); // same server process
    } finally {
      await close();
    }
  }, 30_000);

  it("irreversible heuristic for unannotated tools", () => {
    expect(mcpToolIrreversible({ name: "send_email", inputSchema: {} })).toBe(true);
    expect(mcpToolIrreversible({ name: "send_email", inputSchema: {}, annotations: { readOnlyHint: true } })).toBe(false);
    expect(mcpToolIrreversible({ name: "search", inputSchema: {} })).toBe(false);
  });
});

describe("MCP over Streamable HTTP", () => {
  let http: Server;
  let url: string;
  beforeAll(async () => {
    http = createServer(async (req, res) => {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      await transport.handleRequest(req, res, chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined);
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  });
  afterAll(
    () =>
      new Promise<void>((r) => {
        http.closeAllConnections();
        http.close(() => r());
      }),
  );

  it("blocks private URLs unless the policy allows them", async () => {
    await expect(mcpTools({ name: "local", transport: "http", url })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("calls tools with vault-lent auth headers", async () => {
    const vault = new Vault(new MemorySecretStore(), new MockKeyProvider());
    await vault.put({ workspaceId: "ws_1", name: "FIXTURE_MCP_AUTH", value: "Bearer t0ps3cret-token" });
    const tools = await mcpTools(
      { name: "remote", transport: "http", url, headers: { "x-client": "forge" }, headerSecrets: { authorization: "FIXTURE_MCP_AUTH" } },
      { vault, scope: { workspaceId: "ws_1" }, policy: { allowAddresses: ["127.0.0.1"] } },
    );
    expect(await runTool(tools, "mcp_remote_add", { a: 1, b: 2 }, {})).toEqual({ ok: true, output: "3" });
    const who = await runTool(tools, "mcp_remote_whoami", {}, {});
    expect(who.output).toBe(`sha256:${createHash("sha256").update("Bearer t0ps3cret-token").digest("hex")}`);
    await expect(mcpTools({ name: "remote", transport: "http", url, headerSecrets: { authorization: "FIXTURE_MCP_AUTH" } }, { vault, scope: { workspaceId: "ws_other" }, policy: { allowAddresses: ["127.0.0.1"] } })).rejects.toMatchObject({ code: "NOT_FOUND" });
  }, 30_000);
});

describe("McpRegistry", () => {
  it("adds, lists, removes per workspace and validates configs", async () => {
    const reg = new McpRegistry(undefined, { allowedCommands: [process.execPath, "npx"] });
    await reg.add("ws_1", stdio);
    await reg.add("ws_1", { name: "linear", transport: "http", url: "https://8.8.8.8/mcp", headerSecrets: { Authorization: "LINEAR_TOKEN" } });
    expect((await reg.list("ws_1")).map((s) => s.name)).toEqual(["fixture", "linear"]);
    expect(await reg.list("ws_2")).toEqual([]);
    const tools = await reg.tools("ws_1", "fixture");
    expect(tools).toHaveLength(4);
    expect(await reg.remove("ws_1", "fixture")).toBe(true);
    await expect(reg.get("ws_1", "fixture")).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(reg.add("ws_1", { name: "bad name!", transport: "stdio", command: "npx" })).rejects.toThrow(/Invalid MCP server config/);
    await expect(reg.add("ws_1", { name: "x", transport: "stdio" })).rejects.toThrow(/requires command/);
    await expect(reg.add("ws_1", { name: "x", transport: "http" })).rejects.toThrow(/requires url/);
    await expect(reg.add("ws_1", { name: "x", transport: "stdio", command: "bash" })).rejects.toThrow(/not allowed/);
    await expect(reg.add("ws_1", { name: "x", transport: "http", url: "https://8.8.8.8/mcp", headers: { Authorization: "Bearer plain" } })).rejects.toThrow(/headerSecrets/);
    await expect(reg.add("ws_1", { name: "x", transport: "http", url: "http://169.254.169.254/mcp" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(new McpRegistry(undefined, { allowStdio: false }).add("ws_1", stdio)).rejects.toThrow(/disabled/);
  }, 30_000);
});
