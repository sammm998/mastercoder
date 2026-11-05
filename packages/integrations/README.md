# @forge/integrations

Everything Forge needs to talk to the outside world on behalf of a user, the build agent, generated apps
and user agents:

- **Connectors** – OAuth app connections brokered by Composio, Nango or Pipedream (or an in-memory mock),
  over a curated **catalog** of 12 apps with bilingual (sv/en) scope descriptions and `irreversible` flags.
- **OpenAPI import** – OpenAPI 3.0/3.1 + Swagger 2.0 (and HTML/text API docs) → operations → agent tools,
  an executor and a generated **typed fetch client** for generated apps.
- **MCP** – per-workspace registry of MCP servers (stdio + Streamable HTTP) via the official
  `@modelcontextprotocol/sdk`, wrapped as agent tools.
- **Vault** – envelope-encrypted secrets (AES-256-GCM DEK per secret, KEK from a local master key or AWS KMS).
- **SSRF guard** – `safeFetch` used for every user-supplied URL.

## Public API

### Connectors
```ts
interface ConnectorProvider {
  listApps(): Promise<AppInfo[]>                       // { name, displayName, authType, scopes: [{ id, description }] }
  getApp(app): Promise<AppInfo>
  initiateConnection({ workspaceId, userId, app, scopes, redirectUrl }): Promise<{ connectionId, redirectUrl }>
  getConnection(connectionId): Promise<{ status, scopes, externalId, app? }>  // status: pending|active|failed|expired|revoked
  listActions(app): Promise<ActionDef[]>               // { name, description, inputSchema, irreversible }
  executeAction({ connectionId, action, input }): Promise<{ ok, data, error?, mock? }>
  revoke(connectionId): Promise<void>
}
createConnectorProvider()                              // CONNECTOR_PROVIDER=composio|nango|pipedream|mock
connectorTools(provider, connectionId, app): Promise<ForgeTool[]>   // irreversible flag preserved
CATALOG, getCatalogApp(app), describeScopes(app, scopes, "sv"|"en")  // show scopes BEFORE connecting
isIrreversibleActionName(name), actionIrreversible(app, action)
```
Catalog apps: HubSpot, Slack, Gmail, Google Sheets, Google Calendar, Notion, GitHub, Stripe, Airtable,
Salesforce, Microsoft Outlook, Microsoft Teams. Actions that send, post, delete, pay/refund, merge, archive,
clear or send calendar invitations are `irreversible: true` (agents-runtime asks a human first). Vendor
actions not in the catalog get the flag from a verb heuristic.

`MockConnectorProvider({ autoApprove?, now? })` simulates consent (`completeAuthorization()` /
`failAuthorization()` when `autoApprove: false`), enforces granted scopes and input schemas, and executes
every catalog action against a deterministic per-(workspace, app) in-memory store (seeded HubSpot
contacts/leads/deals, Slack channels, inbox messages, GitHub repos/PR, Stripe charges, Salesforce leads —
all labelled "(mock)" / `example.com`). Every result carries `mock: true`. `inspect(ws, app, collection)`
shows what an agent did (e.g. sent emails, posted messages).

### OpenAPI
```ts
importOpenApi(source: string | URL | object, opts?): Promise<ImportedApi>
  // URL (fetched via safeFetch), object, JSON/YAML string, local file (opts.allowLocalFiles only),
  // or HTML/text docs -> heuristic (default) or LLM purpose "integrations.docs_to_openapi" (opts.llm)
parseOpenApiDocument(doc), swagger2ToOpenApi3(doc)
openApiTools(api, auth, opts?): ForgeTool[]           // input = params by name + `body`; DELETE/send/pay ops irreversible
callOperation(api, opId, input, auth, opts?)          // { status, ok, contentType, data }
generateTypedClient(api): string                      // TS source of a strict, dependency-free fetch client
authFromScheme(api, secret, schemeName?)              // ApiAuth from the spec's securitySchemes
vaultAuth(vault, scope, secretName, build)            // AuthSource that lends the credential per call
heuristicDocsSpec(text), normalizeDocs(html), docsSpecToOpenApi(spec)
```
`ApiAuth`: `none | apiKey (header/query/cookie) | bearer | basic | oauth2 (access token)`. `AuthSource` is
an `ApiAuth` or a lender function so plaintext credentials exist only during the request. Local `$ref`s
are resolved (cycles cut with a "(recursive X)" placeholder); remote refs become `{}`. Operation ids come
from `operationId` (camelCased) or method + path (`getTasksById`).

The generated client is tested by writing it to a temp dir and running `tsc` with `strict`,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnused*`, plus `@ts-expect-error` checks,
and by executing it against a stubbed fetch. `evals/fixtures/weather-openapi.json` is the benchmark #17 spec.

### MCP
```ts
McpServerConfigSchema   // { name, transport: "stdio"|"http", command/args/env/cwd | url, headers, headerSecrets }
new McpRegistry(store = new MemoryMcpServerStore(), policy?)  // add / remove / list / get / tools per workspace
mcpTools(config, { vault?, scope?, policy? }): Promise<ForgeTool[]>   // stateless: session per call
openMcpTools(config, opts): Promise<{ tools, close }>                 // one persistent session
withMcpSession(config, opts, fn), connectMcp(config)                  // low level (src/adapters/mcp-client.ts)
DrizzleMcpServerStore(db)                                             // persists in `connections` (provider = "mcp")
```
Secret-looking headers (`Authorization`, `*token*`, `*key*`, ...) are rejected in `headers`; put them in the
vault and reference them via `headerSecrets` (header → secret name), resolved per call with `Vault.use`.
Tools are `irreversible` when annotated `destructiveHint`, or (unless `readOnlyHint`) named send/post/delete/pay-like.
Policy: `allowStdio` (default true), `allowedCommands`, and the SSRF `UrlPolicy` for HTTP servers.

### Vault
```ts
new Vault(store: SecretStore, keyProvider: KeyProvider, { previousKeyProviders? })
vault.put({ workspaceId, projectId?, name, value })  -> { id, name, keyId }   // never returns the value
vault.use(scope, name, fn)                             // plaintext only inside fn; results containing it are rejected
vault.listNames(scope), vault.has(scope, name), vault.delete(scope, name)
vault.rotate(newKeyProvider, { workspaceId? })         // re-wraps DEKs, ciphertexts untouched
LocalKeyProvider(keyHexOrBase64, keyId?) / LocalKeyProvider.fromEnv()   // VAULT_MASTER_KEY
AwsKmsKeyProvider({ keyId, region = "eu-central-1" })                   // kms:Encrypt / kms:Decrypt
MockKeyProvider()                                                       // ephemeral random KEK (dev/tests)
createKeyProvider()                                                     // VAULT_KEY_PROVIDER=kms|local|mock
MemorySecretStore, DrizzleSecretStore(db)                               // `secrets` table
```
Design: random 256-bit DEK per secret; AES-256-GCM with AAD `forge-vault:v1|workspace|project|name`, so a
row copied to another scope or tampered with fails the integrity check. The DEK is wrapped by the KEK with
the same scope as context (KMS `EncryptionContext`). Scope is exact: project secrets are invisible to other
projects and to the workspace scope, and vice versa.

### SSRF guard
```ts
safeFetch(url, { method, headers, body, maxBytes = 5 MiB, timeoutMs = 10 s, maxRedirects = 3, allowPrivate, allowAddresses, resolver })
makeSafeFetch(policy): typeof fetch, assertPublicUrl(url, policy), isBlockedAddress(ip)
```
http(s) only, no URL credentials, blocked hostnames (`localhost`, `*.internal`, `*.local`, metadata names),
every DNS answer checked and the connection pinned to the checked address (custom `lookup`, so no DNS
rebinding window), blocked ranges: loopback, RFC1918, CGNAT, link-local/metadata (169.254.169.254,
fd00:ec2::254), multicast, reserved, documentation, IPv4-mapped/compatible, NAT64, 6to4, Teredo, ULA,
site-local. Every redirect hop is re-validated; `Authorization`/`Cookie` are dropped on cross-origin hops.

## Providers

| Provider | Adapter | Real / mock | Env vars |
|---|---|---|---|
| Connector broker | `ComposioConnectorProvider` (REST v3: auth configs, connected accounts, tools/execute; `x-api-key`) | real | `CONNECTOR_PROVIDER=composio`, `COMPOSIO_API_KEY`, `COMPOSIO_BASE_URL`* |
| Connector broker | `NangoConnectorProvider` (connect sessions, connections, action trigger, proxy; Bearer secret key) | real | `CONNECTOR_PROVIDER=nango`, `NANGO_SECRET_KEY`, `NANGO_BASE_URL`* (self-hosted EU) |
| Connector broker | `PipedreamConnectorProvider` (OAuth client credentials, connect tokens, accounts, actions/run) | real | `CONNECTOR_PROVIDER=pipedream`, `PIPEDREAM_CLIENT_ID`, `PIPEDREAM_CLIENT_SECRET`, `PIPEDREAM_PROJECT_ID`, `PIPEDREAM_ENVIRONMENT`* |
| Connector broker | `MockConnectorProvider` | mock (default) | `CONNECTOR_PROVIDER=mock` |
| Vault KEK | `AwsKmsKeyProvider` (`@aws-sdk/client-kms`, eu-central-1) | real | `VAULT_KEY_PROVIDER=kms`, `VAULT_KMS_KEY_ID`*, `AWS_REGION`, AWS credential chain |
| Vault KEK | `LocalKeyProvider` | real (local crypto) | `VAULT_KEY_PROVIDER=local`, `VAULT_MASTER_KEY`, `VAULT_KEY_ID`* |
| Vault KEK | `MockKeyProvider` (ephemeral) | mock | `VAULT_KEY_PROVIDER=mock` (default when no master key) |
| MCP client | `connectMcp` (`@modelcontextprotocol/sdk`, stdio + Streamable HTTP) | real | – |
| Docs → OpenAPI | LLM purpose `integrations.docs_to_openapi` (MODEL_BUILDER) / heuristic | real / mock handler = heuristic | `LLM_PROVIDER` |

\* new env vars (not yet in `.env.example`): `COMPOSIO_BASE_URL`, `NANGO_BASE_URL`, `PIPEDREAM_ENVIRONMENT`
(`production`|`development`), `VAULT_KEY_PROVIDER`, `VAULT_KMS_KEY_ID`, `VAULT_KEY_ID`.

Usage metering: the only billable call in this package is the optional LLM docs conversion; pass
`usage` to `importOpenApi` and it is wrapped in `MeteredLLM` (prices from `@forge/llm`). Broker-side
connector costs are billed by the broker per plan and are not metered per call here.

## Tests
- Unit (`pnpm --filter @forge/integrations test`): catalog, mock broker, connector tools, Composio/Nango/
  Pipedream request mapping (stubbed `fetch`), SSRF (address table, DNS answers, redirects, size, timeout),
  OpenAPI import/Swagger 2/YAML/docs heuristic/LLM path, typed client `tsc` check + runtime, MCP stdio
  fixture (`test/fixtures/mcp-server.mjs`) and in-process Streamable HTTP server, vault (tamper, scope,
  rotation, KMS via `vi.mock`).
- Integration (`pnpm --filter @forge/integrations test:integration`, docker Postgres): `DrizzleSecretStore`
  (scope, NULL-project upsert, DB tampering, rotation) and `DrizzleMcpServerStore`.

## Limitations
- Real broker adapters are verified against stubbed responses only (no vendor keys here). Vendor action
  names differ per broker (Composio `HUBSPOT_LIST_CONTACTS`, Pipedream `slack-send-message`, Nango scripts);
  `listActions` returns the broker's names, the catalog defines Forge's canonical set used by the mock.
- Nango/Pipedream connection ids are opaque Forge ids encoding (integration, end user); the vendor id is
  looked up after consent. Granted scopes are reported from the vendor when exposed, else the requested ones.
- `safeFetch` connects directly (ignores `HTTP(S)_PROXY`) because a proxy would defeat address pinning; it
  requests `accept-encoding: identity` (no decompression). MCP HTTP streams use `assertPublicUrl` per request
  plus `redirect: "error"` (not address-pinned: small DNS-rebinding window).
- Remote `$ref`s (other files/URLs) are not fetched. The docs heuristic only finds `METHOD /path` patterns and
  parameter tables; results are labelled `docs-heuristic` and should be reviewed.
- `Vault.rotate({ workspaceId })` re-wraps one tenant's DEKs but new writes still use the vault's current key
  (per-tenant key routing is not implemented). `use()` rejects results containing the plaintext only by
  substring match (secrets shorter than 4 chars are not checked).
- stdio MCP servers spawn local processes: run the worker inside the sandbox or set `allowedCommands`.
