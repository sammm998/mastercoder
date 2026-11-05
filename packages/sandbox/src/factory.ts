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
      local: () => new LocalSandboxProvider(common),
      mock: () => new MockSandboxProvider(common),
    },
    "docker",
  );
  if (selected.instance.isMock) log.warn("sandbox provider has NO isolation (tests only)", { provider: selected.name });
  return selected.instance;
}
