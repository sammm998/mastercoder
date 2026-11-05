// Tiny MCP server used by tests (stdio when run directly; `buildServer` is reused for the HTTP test).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHash } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { z } from "zod";

export function buildServer() {
  const server = new McpServer({ name: "forge-test-fixture", version: "1.0.0" });
  const notes = new Map([["n1", "first note"]]);
  server.registerTool(
    "add",
    { description: "Add two numbers", inputSchema: { a: z.number(), b: z.number() }, annotations: { readOnlyHint: true } },
    async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
  );
  server.registerTool(
    "get_note",
    { description: "Read a note", inputSchema: { id: z.string() }, outputSchema: { id: z.string(), text: z.string() }, annotations: { readOnlyHint: true } },
    async ({ id }) => {
      const text = notes.get(id);
      if (!text) return { isError: true, content: [{ type: "text", text: `note ${id} not found` }] };
      return { content: [{ type: "text", text }], structuredContent: { id, text } };
    },
  );
  server.registerTool(
    "delete_note",
    { description: "Delete a note", inputSchema: { id: z.string() }, annotations: { destructiveHint: true } },
    async ({ id }) => ({ content: [{ type: "text", text: notes.delete(id) ? "deleted" : "missing" }] }),
  );
  server.registerTool(
    "whoami",
    { description: "Hash of the auth header the HTTP server saw (never echoes the secret)", inputSchema: {}, annotations: { readOnlyHint: true } },
    async (_args, extra) => {
      const h = extra?.requestInfo?.headers?.authorization;
      return { content: [{ type: "text", text: h ? `sha256:${createHash("sha256").update(String(h)).digest("hex")}` : "none" }] };
    },
  );
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}
