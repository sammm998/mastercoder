import { and, eq, isNull, or, connections, projects, type Db } from "@forge/db";
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

  /** Active connector connections a project can use: its own first, then workspace-wide ones. */
  private async projectConnections(projectId: string) {
    const [p] = await this.db.select({ workspaceId: projects.workspaceId }).from(projects).where(eq(projects.id, projectId));
    if (!p) throw new ForgeError("NOT_FOUND", "Project not found");
    const rows = await this.db
      .select()
      .from(connections)
      .where(and(eq(connections.workspaceId, p.workspaceId), or(eq(connections.projectId, projectId), isNull(connections.projectId))));
    return rows
      .filter((r) => r.status === "active" && r.provider !== "openapi" && r.provider !== "mcp")
      .sort((a, b) => Number(!!b.projectId) - Number(!!a.projectId));
  }

  /** Tools for the build agent (`use_integration`): `<app>.<action>` for each connected app. */
  async listProjectTools(projectId: string): Promise<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>> {
    const seen = new Set<string>();
    const out: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [];
    for (const c of await this.projectConnections(projectId)) {
      if (seen.has(c.app)) continue;
      seen.add(c.app);
      for (const a of await this.connectors.listActions(c.app)) out.push({ name: `${c.app}.${a.name}`, description: `${a.irreversible ? "[irreversible — ask the user first] " : ""}${a.description}`, inputSchema: a.inputSchema as Record<string, unknown> });
    }
    return out;
  }

  async callProjectTool(projectId: string, tool: string, input: unknown): Promise<unknown> {
    const dot = tool.indexOf(".");
    if (dot < 1) throw new ForgeError("BAD_INPUT", `Tool must be "<app>.<action>", got "${tool}" — use tool="list"`);
    const app = tool.slice(0, dot);
    const action = tool.slice(dot + 1);
    const c = (await this.projectConnections(projectId)).find((r) => r.app === app);
    if (!c) throw new ForgeError("NOT_FOUND", `No active ${app} connection for this project — connect it in the project's Integrations tab`);
    const def = (await this.connectors.listActions(app)).find((a) => a.name === action);
    if (def?.irreversible) throw new ForgeError("BAD_INPUT", `${tool} is irreversible (sends, posts, deletes or pays); the build agent may not run it — ask the user to run it from an agent with approval`);
    return this.connectors.executeAction({ connectionId: c.externalId ?? c.id, action, input: (input ?? {}) as Record<string, unknown> });
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
      try {
        return await this.connectors.executeAction({ connectionId: c.externalId ?? c.id, action: ref.action, input: args });
      } catch (e) {
        // MockConnectorProvider keeps connections in process memory; a connection made through the API
        // process is unknown here, so in mock mode only, re-create it in this process and retry.
        if (!this.connectors.isMock || (e as { code?: string }).code !== "NOT_FOUND") throw e;
        const r = await this.connectors.initiateConnection({ workspaceId: ctx.workspaceId, userId: c.userId, app: ref.app, scopes: (c.scopes as string[]) ?? [], redirectUrl: "http://localhost/mock" });
        await this.connectors.getConnection(r.connectionId);
        await this.db.update(connections).set({ externalId: r.connectionId, status: "active" }).where(eq(connections.id, c.id));
        return this.connectors.executeAction({ connectionId: r.connectionId, action: ref.action, input: args });
      }
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
