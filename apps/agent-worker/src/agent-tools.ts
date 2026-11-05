import { and, eq, connections, type Db } from "@forge/db";
import { ForgeError } from "@forge/shared";
import type { ToolExecutor, ToolRef } from "@forge/agents-runtime";
import { importOpenApi, callOperation, vaultAuth, type ConnectorProvider, type Vault } from "@forge/integrations";

/**
 * Executes user-agent tools through the workspace's connections: connector actions (Composio / Nango /
 * Pipedream / mock) and OpenAPI operations (auth lent from the vault for one request).
 */
export class ConnectionToolExecutor implements ToolExecutor {
  constructor(
    private readonly db: Db,
    private readonly connectors: ConnectorProvider,
    private readonly vault: Vault,
  ) {}

  private async connection(workspaceId: string, where: { app?: string; id?: string }) {
    const rows = await this.db
      .select()
      .from(connections)
      .where(and(eq(connections.workspaceId, workspaceId), where.id ? eq(connections.id, where.id) : eq(connections.app, where.app ?? "")));
    const c = rows.find((r) => r.status === "active" || r.status === "pending");
    if (!c) throw new ForgeError("NOT_FOUND", `No active ${where.app ?? where.id} connection in this workspace — connect it under Integrations`);
    return c;
  }

  async describe(ref: ToolRef): Promise<{ description: string; inputSchema: Record<string, unknown> }> {
    if (ref.type === "integration") {
      const actions = await this.connectors.listActions(ref.app);
      const a = actions.find((x) => x.name === ref.action);
      if (!a) return { description: `${ref.app} ${ref.action}`, inputSchema: { type: "object", properties: {} } };
      return { description: a.description, inputSchema: a.inputSchema as Record<string, unknown> };
    }
    if (ref.type === "openapi") return { description: `API operation ${ref.operationId}`, inputSchema: { type: "object", additionalProperties: true } };
    if (ref.type === "mcp") return { description: `MCP tool ${ref.tool}`, inputSchema: { type: "object", additionalProperties: true } };
    return { description: ref.name, inputSchema: { type: "object", properties: {} } };
  }

  async execute(ref: ToolRef, input: unknown, ctx: { workspaceId: string; agentId: string }): Promise<unknown> {
    const args = (input ?? {}) as Record<string, unknown>;
    if (ref.type === "integration") {
      const c = await this.connection(ctx.workspaceId, { app: ref.app });
      return this.connectors.executeAction({ connectionId: c.externalId ?? c.id, action: ref.action, input: args });
    }
    if (ref.type === "openapi") {
      const c = await this.connection(ctx.workspaceId, { id: ref.connectionId });
      const cfg = (c.config ?? {}) as { spec?: Record<string, unknown>; secretName?: string; authHeader?: string };
      if (!cfg.spec) throw new ForgeError("BAD_INPUT", "OpenAPI connection has no stored spec");
      const api = await importOpenApi(cfg.spec);
      if (!cfg.secretName) return (await callOperation(api, ref.operationId, args)).data;
      const auth = vaultAuth(this.vault, { workspaceId: ctx.workspaceId, projectId: null }, cfg.secretName, (secret) => ({ type: "apiKey", in: "header", name: cfg.authHeader ?? "x-api-key", value: secret }) as never);
      return (await callOperation(api, ref.operationId, args, auth)).data;
    }
    if (ref.type === "mcp") throw new ForgeError("BAD_INPUT", "MCP tools are not available to scheduled agents yet; use a connector or OpenAPI tool");
    throw new ForgeError("BAD_INPUT", `Unsupported tool ${JSON.stringify(ref)}`);
  }
}
