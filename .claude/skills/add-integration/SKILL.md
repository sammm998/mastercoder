---
name: add-integration
description: Add a first-class integration (app connector, OpenAPI-based API, or MCP server) usable by the build agent, generated apps and user agents.
---
1. Connector apps (HubSpot, Slack, Gmail...): add to `packages/integrations/src/catalog.ts` with scopes and actions;
   the connector provider (Composio/Nango/Pipedream) handles OAuth. Scopes must be shown before connecting.
2. Plain REST APIs: prefer `importOpenApi(specUrlOrJson)` → generated tools; add a fixture spec under `test/fixtures/`.
3. MCP servers: register with `McpRegistry.add({ name, transport, url|command })`.
4. Credentials go into the vault (`Vault.put`) — never into project files or browser code.
5. Mark irreversible actions (`send`, `delete`, `pay`) as `irreversible: true` so agents-runtime asks for approval.
6. Tests with stubbed fetch for the action mapping and a vault round-trip.
