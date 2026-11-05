import { env, selectAdapter } from "@forge/shared";
import { defineTool, type ForgeTool } from "@forge/llm";
import { jsonSchemaToZod } from "./json-schema.js";
import { MockConnectorProvider } from "./mock-connector.js";
import { ComposioConnectorProvider } from "./adapters/composio.js";
import { NangoConnectorProvider } from "./adapters/nango.js";
import { PipedreamConnectorProvider } from "./adapters/pipedream.js";
import type { ConnectorProvider } from "./types.js";

/** CONNECTOR_PROVIDER=composio|nango|pipedream|mock (default mock). */
export function createConnectorProvider(): ConnectorProvider {
  return selectAdapter<ConnectorProvider>(
    "CONNECTOR_PROVIDER",
    {
      composio: () => new ComposioConnectorProvider({ apiKey: env("COMPOSIO_API_KEY"), baseUrl: process.env.COMPOSIO_BASE_URL || undefined }),
      nango: () => new NangoConnectorProvider({ secretKey: env("NANGO_SECRET_KEY"), baseUrl: process.env.NANGO_BASE_URL || undefined }),
      pipedream: () =>
        new PipedreamConnectorProvider({
          clientId: env("PIPEDREAM_CLIENT_ID"),
          clientSecret: env("PIPEDREAM_CLIENT_SECRET"),
          projectId: env("PIPEDREAM_PROJECT_ID"),
          environment: process.env.PIPEDREAM_ENVIRONMENT === "development" ? "development" : "production",
        }),
      mock: () => new MockConnectorProvider(),
    },
    "mock",
  ).instance;
}

/** Tool names must match ^[a-zA-Z0-9_-]{1,64}$ for every LLM provider. */
export function toolName(...parts: string[]): string {
  return parts
    .join("_")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 64);
}

/**
 * Agent tools for one connected account. Each tool validates input against the action's JSON schema and
 * carries the action's `irreversible` flag so agents-runtime asks for approval before send/post/delete/pay.
 */
export async function connectorTools(provider: ConnectorProvider, connectionId: string, app: string): Promise<ForgeTool[]> {
  const actions = await provider.listActions(app);
  return actions.map((a) =>
    defineTool({
      name: toolName(app, a.name),
      description: `${a.description} (${app} via ${provider.name}${provider.isMock ? ", mock" : ""})`,
      input: jsonSchemaToZod(a.inputSchema),
      irreversible: a.irreversible,
      run: async (input) => {
        const r = await provider.executeAction({ connectionId, action: a.name, input: (input ?? {}) as Record<string, unknown> });
        if (!r.ok) throw new Error(r.error ?? `${app}.${a.name} failed`);
        return { data: r.data as unknown, ...(r.mock ? { mock: true } : {}) } as Record<string, unknown>;
      },
    }),
  ) as ForgeTool[];
}
