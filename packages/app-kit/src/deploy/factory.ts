import { selectAdapter } from "@forge/shared";
import { FlyDeployProvider } from "../adapters/fly.js";
import { LocalDeployProvider } from "../adapters/local-docker.js";
import { MockDeployProvider } from "./mock.js";
import type { DeployProvider } from "./types.js";

/** DEPLOY_PROVIDER=fly|local|mock (default mock). */
export function createDeployProvider(): DeployProvider {
  return selectAdapter<DeployProvider>(
    "DEPLOY_PROVIDER",
    {
      fly: () => new FlyDeployProvider(),
      local: () => new LocalDeployProvider(),
      mock: () => new MockDeployProvider(),
    },
    "mock",
  ).instance;
}
