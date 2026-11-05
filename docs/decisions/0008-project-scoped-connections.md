# 0008 — Project-scoped integrations via Composio connect links

## Context
Integrations were workspace-wide: one HubSpot account per workspace, shared by every project. Users want
to connect an app inside one project (e.g. a client's HubSpot for that client's site) without it leaking
into other projects.

## Decision
- `connections.project_id` (nullable). Null = shared with the workspace; set = that project only.
- Project editors may connect and revoke a project's own connections; shared ones stay admin-only.
- Composio adapter moves to REST v3.1 and starts connections with `POST /api/v3.1/connected_accounts/link`
  (hosted Connect Link). `user_id` is the project id for project connections and the workspace id for
  shared ones, so each project has its own Composio accounts.
- The build agent's `use_integration` tool sees the project's connections first, then shared ones; it may
  not run irreversible actions (send/post/delete/pay).
- Endpoint shapes were taken from Composio's published `@composio/client` 2.1.0 types (docs site was not
  reachable from the build environment).

## Consequences
One migration (0004). Existing connections remain workspace-wide. Mock/Nango/Pipedream adapters ignore
`projectId` except for their own user scoping.
