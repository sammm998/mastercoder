import { createLogger, selectAdapter, type UsageSink } from "@forge/shared";
import type { SandboxProvider } from "./types.js";
import type { SnapshotStore } from "./snapshots.js";
import { DockerSandboxProvider } from "./adapters/docker/provider.js";
import { LocalSandboxProvider, MockSandboxProvider } from "./adapters/local.js";
import { E2BSandboxProvider } from "./adapters/e2b.js";
import { DaytonaSandboxProvider } from "./adapters/daytona.js";

export interface SandboxProviderOptions {
  usage?: UsageSink;
  snapshotStore?: SnapshotStore;
}

/**
 * Host proxy / CA / npm / pip settings for the NO-isolation local sandbox, so package installs work
 * behind a corporate or agent proxy. Isolated providers (docker, e2b, daytona) never receive host env.
 */
export function hostNetworkEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && /proxy|^npm_config_|^NODE_EXTRA_CA_CERTS$|^SSL_CERT_FILE$|^REQUESTS_CA_BUNDLE$|^PIP_/i.test(k)) env[k] = v;
  if (process.env.HOME) env.npm_config_cache ??= `${process.env.HOME}/.npm`;
  // Vite dev servers reject unknown Host headers; also allow the worker's private hostname (preview proxy).
  if (process.env.RAILWAY_PRIVATE_DOMAIN) env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS = process.env.RAILWAY_PRIVATE_DOMAIN;
  return env;
}

const log = createLogger({ mod: "sandbox" });

/** SANDBOX_PROVIDER=e2b|daytona|docker|local (also "mock" → local, no isolation). Default: docker. */
export function createSandboxProvider(opts: SandboxProviderOptions = {}): SandboxProvider {
  const common = { usage: opts.usage, snapshotStore: opts.snapshotStore };
  const selected = selectAdapter<SandboxProvider>(
    "SANDBOX_PROVIDER",
    {
      docker: () => new DockerSandboxProvider(common),
      e2b: () => new E2BSandboxProvider(common),
      daytona: () => new DaytonaSandboxProvider(common),
      local: () => new LocalSandboxProvider({ ...common, env: hostNetworkEnv() }),
      mock: () => new MockSandboxProvider({ ...common, env: hostNetworkEnv() }),
    },
    "docker",
  );
  if (selected.instance.isMock) log.warn("sandbox provider has NO isolation (tests only)", { provider: selected.name });
  return selected.instance;
}
