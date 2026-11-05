import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ForgeError } from "@forge/shared";
import type { JsonSchema } from "@forge/llm";

export interface McpConnectConfig {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  /** Resolved headers (including secrets lent by the vault for this session only). */
  headers?: Record<string, string>;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean; title?: string };
}

export interface McpCallResult {
  isError: boolean;
  text: string;
  structured?: Record<string, unknown>;
}

export interface McpSession {
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  close(): Promise<void>;
}

/** Connect with the official MCP TypeScript SDK over stdio or Streamable HTTP. */
export async function connectMcp(cfg: McpConnectConfig, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<McpSession> {
  const client = new Client({ name: "forge", version: "0.1.0" }, { capabilities: {} });
  let transport: StdioClientTransport | StreamableHTTPClientTransport;
  if (cfg.transport === "stdio") {
    if (!cfg.command) throw new ForgeError("BAD_INPUT", `MCP server ${cfg.name}: stdio transport needs a command`);
    transport = new StdioClientTransport({ command: cfg.command, args: cfg.args ?? [], env: cfg.env, cwd: cfg.cwd, stderr: "ignore" });
  } else {
    if (!cfg.url) throw new ForgeError("BAD_INPUT", `MCP server ${cfg.name}: http transport needs a url`);
    transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: { headers: cfg.headers ?? {}, redirect: "error" },
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }
  const timeout = opts.timeoutMs ?? 30_000;
  try {
    await client.connect(transport, { timeout });
  } catch (e) {
    await transport.close().catch(() => undefined);
    throw new ForgeError("PROVIDER_ERROR", `MCP server ${cfg.name}: connect failed: ${(e as Error).message}`);
  }
  return {
    async listTools() {
      const out: McpToolInfo[] = [];
      let cursor: string | undefined;
      do {
        const r = await client.listTools(cursor ? { cursor } : {}, { timeout });
        for (const t of r.tools) {
          out.push({
            name: t.name,
            ...(t.description ? { description: t.description } : {}),
            inputSchema: (t.inputSchema as JsonSchema) ?? { type: "object" },
            ...(t.annotations ? { annotations: t.annotations } : {}),
          });
        }
        cursor = r.nextCursor;
      } while (cursor);
      return out;
    },
    async callTool(name, args) {
      const r = await client.callTool({ name, arguments: args }, undefined, { timeout });
      const content = Array.isArray(r.content) ? (r.content as Array<Record<string, unknown>>) : [];
      const text = content
        .map((c) => (c.type === "text" ? String(c.text) : c.type === "resource" ? JSON.stringify(c.resource) : `[${String(c.type)}${c.mimeType ? ` ${String(c.mimeType)}` : ""}]`))
        .join("\n");
      const structured = r.structuredContent && typeof r.structuredContent === "object" ? (r.structuredContent as Record<string, unknown>) : undefined;
      return { isError: r.isError === true, text, ...(structured ? { structured } : {}) };
    },
    async close() {
      await client.close().catch(() => undefined);
    },
  };
}
