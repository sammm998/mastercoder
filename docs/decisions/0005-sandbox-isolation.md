# 0005 — Sandbox isolation and egress

**Decision:** Production sandboxes are microVMs (E2B / Daytona adapters). For local dev and CI the
`DockerSandboxProvider` runs one hardened container per project (cap-drop ALL, no-new-privileges, non-root,
pids/cpu/memory limits, tmpfs /tmp) on its own `--internal` network. The only egress is the Forge egress proxy
(HTTP CONNECT + HTTP), which enforces a per-project host allowlist, resolves DNS itself and rejects private,
loopback, link-local/metadata, CGNAT and multicast addresses. When the host has an upstream proxy on loopback,
a host-network relay listens only on the egress bridge gateway and accepts only that subnet.

**Why:** gives real, testable isolation (`packages/sandbox/test/escape.int.test.ts`: no cross-project, metadata,
host-service or direct internet access) without needing nested virtualisation locally.

**Trade-off:** Docker shares the host kernel (no gVisor yet) and has no disk quota; this is why production uses
microVM providers.
