# @forge/sandbox

Isolated, per-project execution environments for Forge agents: run commands, read/write files, snapshot and
restore `/workspace`, expose preview ports, pause/resume, and meter `sandbox_minutes`.

## Public API

```ts
import { createSandboxProvider, copyDirToSandbox } from "@forge/sandbox";

const provider = createSandboxProvider({ usage, snapshotStore }); // SANDBOX_PROVIDER=e2b|daytona|docker|local|mock
const sb = await provider.create({ projectId, cpu: 2, memoryMb: 2048, egressAllowlist: ["api.stripe.com"] });
await sb.exec("npm ci", { timeoutMs: 600_000 });            // { exitCode, stdout, stderr, durationMs, timedOut }
await sb.writeFile("src/app.ts", code); await sb.readFile("package.json");
await sb.listFiles(".", { recursive: true, exclude: ["node_modules"] });
const { snapshotId } = await sb.snapshot("before-refactor"); await sb.restore(snapshotId);
const { url } = await sb.exposePort(3000);
await sb.pause(); await sb.resume(); await sb.destroy();
```

Contract types (`SandboxSpec`, `ExecOptions`, `ExecResult`, `Sandbox`, `SandboxProvider`) are exactly those in
`BUILD_PLAN.md`; extensions: `ListFilesOptions.exclude`, `SandboxSpecSchema` (zod), `copyDirToSandbox`,
`SnapshotStore`, `SandboxMeter`, egress policy helpers (`decide`, `checkIp`, `matchesAllowlist`),
`createEgressProxy`, `DockerEgress`.

`listFiles` returns paths relative to the directory; recursive listings return files only, non-recursive listings
return files and directories (directories end with `/`).

## Providers

| adapter | real/mock | env vars |
|---|---|---|
| `docker` (default) | real — docker CLI via `child_process` (no SDK) | `SANDBOX_DOCKER_IMAGE`, `SANDBOX_DOCKER_PREFIX`, `SANDBOX_DOCKER_USER`, `SANDBOX_DEFAULT_CPU`, `SANDBOX_DEFAULT_MEMORY_MB`, `SANDBOX_DOCKER_PIDS_LIMIT`, `SANDBOX_DOCKER_TMP_MB`, `SANDBOX_DOCKER_EXPOSE`, `SANDBOX_EGRESS_*`, `SANDBOX_UPSTREAM_*`, `SANDBOX_DOCKER_USD_PER_VCPU_HOUR`, `SANDBOX_DOCKER_USD_PER_GB_HOUR` |
| `e2b` | real — official `e2b` SDK (Firecracker microVMs) | `E2B_API_KEY`, `E2B_TEMPLATE` |
| `daytona` | real — official `@daytonaio/sdk` | `DAYTONA_API_KEY`, `DAYTONA_API_URL`, `DAYTONA_TARGET` (default `eu`) |
| `local` / `mock` | **mock — NO ISOLATION**, temp dir + `child_process` on the host. Tests and fixture runs only. | – |

All providers share `SANDBOX_PROVIDER`, `SANDBOX_EGRESS_ALLOWLIST`, `SANDBOX_SNAPSHOT_DIR`.

## Docker isolation model

- One container per project (`<prefix>-sbx-<project>`, label `forge.project=<id>`); `create()` for a project
  with a running container returns it. Workdir `/workspace`, owned by the sandbox user.
- Hardening: `--cpus`, `--memory` (= `--memory-swap`, no swap), `--pids-limit 512`, `--cap-drop ALL`,
  `--security-opt no-new-privileges`, non-root `--user 1000:1000`, `--init`, tmpfs `/tmp` (nosuid,nodev).
  `timeoutSec` becomes the container's main process (`sleep N`), so the sandbox stops itself.
- Exec: `docker exec … timeout -s KILL <s> sh -c <cmd>` — the deadline is enforced inside the container
  (coreutils `timeout` kills the whole process group) with a host-side backstop.
- Network: each project gets its own `--internal` network (no default route, no gateway to the host). The only way
  out is the **Forge egress proxy** (`src/egress-proxy.ts`), one container attached to every project network
  (alias `forge-egress`) and to a normal bridge `<prefix>-egress`. Sandboxes get
  `HTTP_PROXY/HTTPS_PROXY=http://forge-egress:3128`.
- Proxy policy (`src/egress-policy.ts`): per-project allowlist = `SANDBOX_EGRESS_ALLOWLIST` (default: npm, yarn,
  PyPI registries) + `spec.egressAllowlist`; entries `host`, `*.host` (subdomains), `.host` (apex+subdomains),
  `host:port` (otherwise ports 80/443 only). Always denied: 0/8, 10/8, 100.64/10, 127/8, 169.254/16 (incl.
  169.254.169.254), 172.16/12, 192.168/16, 192.0.0/24, 198.18/15, documentation ranges, multicast/reserved,
  `::`, `::1`, fc00::/7, fe80::/10, fec0::/10, ff00::/8, IPv4-mapped/NAT64 forms of those; metadata and internal
  hostnames (`metadata.google.internal`, `metadata`, `instance-data`, `*.internal`, `localhost`, `*.local`, …).
  The proxy resolves DNS itself, rejects the request if **any** resolved address is blocked, and dials only the
  verified addresses (no DNS rebinding). The project is identified by the proxy's own address on the network the
  connection arrived on, so a project can never borrow another project's allowlist. Decisions are logged as JSON
  lines (`docker logs <prefix>-egress-proxy`).
- Proxy config is generated from docker state (project networks + their `forge.egress` label) and pushed with
  `docker exec` + `SIGHUP`; the provider waits until the proxy confirms the version. A fresh proxy (e.g. after a
  daemon restart) denies everything until the next sync (fail closed).
- **Upstream proxy chaining.** If the host has `HTTPS_PROXY` (or `SANDBOX_UPSTREAM_PROXY`) set, allowed traffic
  goes `sandbox → egress proxy → upstream` via `CONNECT` (plain HTTP is tunnelled with `CONNECT host:80`, because
  many upstreams only support CONNECT). When the upstream listens on the host's loopback (e.g.
  `http://127.0.0.1:35535`), the egress-proxy container cannot reach it, so the provider starts a tiny relay
  container `<prefix>-egress-relay` with `--network host` that listens **only on the egress bridge's gateway IP**
  and accepts only that bridge's subnet, forwarding raw TCP to the loopback upstream. Sandboxes are not on that
  bridge, so they cannot reach the relay. If the upstream re-terminates TLS, its CA bundle
  (`SANDBOX_UPSTREAM_CA_FILE`, default `NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE`) is copied into each sandbox at
  `/etc/forge/upstream-ca.crt` and `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`,
  `PIP_CERT`, `GIT_SSL_CAINFO`, `npm_config_cafile` point at it (the egress proxy itself only tunnels bytes and
  needs no CA). Upstream credentials are sent as `Proxy-Authorization` and never logged.
- `exposePort`: `ip` mode (default) returns `http://<container-ip>:<port>` — reachable from a Linux docker host.
  `publish` mode (`SANDBOX_DOCKER_EXPOSE=publish`, for Docker Desktop) starts a forwarder container published on
  `127.0.0.1:<random>`.
- Snapshots: `tar -czf` of `/workspace` stored in an `ObjectStore` (default `LocalObjectStore` in
  `SANDBOX_SNAPSHOT_DIR`, or pass an S3-backed `SnapshotStore`) at `sandbox-snapshots/<project>/<snapshotId>`;
  `restore` replaces `/workspace` contents. The same format is used by every provider.
- `pause`/`resume`: `docker pause/unpause`. `destroy`: removes the container, its forwarders and, when empty, the
  project network.

## Metering

`sandbox_minutes` is recorded into the optional `UsageSink` on `pause()` and `destroy()` for the active window.
Prices (see `src/metering.ts`): E2B and Daytona $0.000014/vCPU-s + $0.0000045/GiB-s (vendor pricing pages);
Docker self-hosted ≈ $0.0059/vCPU-hour (Hetzner CPX41 list price; override via env); local = $0.

## New env vars

`SANDBOX_PROVIDER` (default `docker`), `SANDBOX_EGRESS_ALLOWLIST`, `SANDBOX_EGRESS_IMAGE`,
`SANDBOX_EGRESS_RELAY_PORT` (39129), `SANDBOX_UPSTREAM_PROXY` (`none` disables; default host `HTTPS_PROXY`),
`SANDBOX_UPSTREAM_CA_FILE`, `SANDBOX_SNAPSHOT_DIR`, `SANDBOX_DOCKER_IMAGE` (`node:22-bookworm-slim`),
`SANDBOX_DOCKER_PREFIX` (`forge`), `SANDBOX_DOCKER_USER` (`1000:1000`), `SANDBOX_DEFAULT_CPU` (2),
`SANDBOX_DEFAULT_MEMORY_MB` (2048), `SANDBOX_DOCKER_PIDS_LIMIT` (512), `SANDBOX_DOCKER_TMP_MB` (512),
`SANDBOX_DOCKER_EXPOSE` (`ip|publish`), `SANDBOX_DOCKER_USD_PER_VCPU_HOUR`, `SANDBOX_DOCKER_USD_PER_GB_HOUR`,
`E2B_API_KEY`, `E2B_TEMPLATE`, `DAYTONA_API_KEY`, `DAYTONA_API_URL`, `DAYTONA_TARGET`.

## Tests

- `pnpm --filter @forge/sandbox test` — unit (policy, proxy with injected DNS/dialer, local provider, E2B and
  Daytona adapters with `vi.mock` of the SDKs, docker argv, tar, metering).
- `pnpm --filter @forge/sandbox test:integration` — real docker: exec/files/list, timeouts, snapshot→restore,
  exposePort (ip + publish) with a real HTTP server, limits via `docker inspect`, pause/resume, destroy; and
  `test/escape.int.test.ts`: A↛B by IP/port (direct and via proxy), A↛proxy-on-B, A↛169.254.169.254 and
  `metadata.google.internal`, A↛host Postgres/Redis on every gateway, no direct internet route, non-allowlisted
  host denied, allowlisted `registry.npmjs.org` reachable through the proxy (and `npm ping` works).

## Limitations

- Docker is a shared-kernel boundary; for hostile multi-tenant code prefer `e2b` (microVMs) or run the docker
  provider with gVisor (`--runtime=runsc`, not wired yet). No disk quota (`--storage-opt` needs xfs/overlay quotas).
- When chaining to an upstream proxy, the upstream re-resolves the hostname we verified; the residual rebinding
  window is on the upstream's side of the trust boundary. Without an upstream we dial the verified IPs.
- Metering of sandboxes re-attached via `get()` starts at the container's `StartedAt` (pause history before the
  current process is unknown).
- Base images must provide `sh`, `timeout`, `tar`, `find`, `cat` (Debian/Alpine images do).
- `create()` reuses a project's running container as-is; to change its image/limits/allowlist, `destroy()` it
  first. Internal networks also get no external DNS (verified in the escape tests), so DNS tunnelling is closed.
- The proxy code is type-stripped with `module.stripTypeScriptTypes` (Node ≥ 22.13, prints an
  ExperimentalWarning once) or, on older Nodes, the TypeScript compiler.
- E2B: CPU/RAM are fixed by the template; egress allowlist is by hostname (ports are dropped). Daytona: pause =
  `stop()` (filesystem kept, processes stopped).
- `local`/`mock` gives no isolation and must never run untrusted code.
