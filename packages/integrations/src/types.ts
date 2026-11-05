import type { JsonSchema } from "@forge/llm";

export type Locale = "sv" | "en";

export type AuthType = "oauth2" | "api_key" | "basic" | "none";

export interface ScopeInfo {
  id: string;
  description: string;
}

export interface AppInfo {
  /** Catalog slug, e.g. "hubspot". */
  name: string;
  displayName: string;
  authType: AuthType;
  scopes: ScopeInfo[];
}

export interface ActionDef {
  name: string;
  description: string;
  /** JSON schema of the action input (object). */
  inputSchema: JsonSchema;
  /** send / post / delete / pay actions: agents-runtime must ask a human before running them. */
  irreversible: boolean;
}

export interface InitiateConnectionInput {
  workspaceId: string;
  userId: string;
  app: string;
  scopes: string[];
  /** Where the provider sends the user after consent. */
  redirectUrl: string;
}

export interface InitiatedConnection {
  connectionId: string;
  /** URL the user must visit to grant consent. */
  redirectUrl: string;
}

export type ConnectionStatus = "pending" | "active" | "failed" | "expired" | "revoked";

export interface ConnectionInfo {
  status: ConnectionStatus;
  scopes: string[];
  /** Vendor-side id (Composio connected account, Nango connection, Pipedream account). */
  externalId: string | null;
  app?: string;
}

export interface ExecuteActionInput {
  connectionId: string;
  action: string;
  input: Record<string, unknown>;
}

export interface ActionResult {
  ok: boolean;
  data: unknown;
  error?: string;
  /** Present and true only for results produced by MockConnectorProvider. */
  mock?: boolean;
}

/** OAuth connector broker (Composio / Nango / Pipedream / mock). */
export interface ConnectorProvider {
  readonly name: string;
  readonly isMock: boolean;
  listApps(): Promise<AppInfo[]>;
  getApp(app: string): Promise<AppInfo>;
  initiateConnection(input: InitiateConnectionInput): Promise<InitiatedConnection>;
  getConnection(connectionId: string): Promise<ConnectionInfo>;
  listActions(app: string): Promise<ActionDef[]>;
  executeAction(input: ExecuteActionInput): Promise<ActionResult>;
  revoke(connectionId: string): Promise<void>;
}
