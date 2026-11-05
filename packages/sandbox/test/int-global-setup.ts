import { dockerRaw } from "../src/adapters/docker/cli.js";

const PREFIX = "forgetest";

async function removeAll(): Promise<void> {
  const ps = await dockerRaw(["ps", "-aq", "--filter", `label=forge.prefix=${PREFIX}`]);
  const ids = ps.stdout.toString().split("\n").filter(Boolean);
  if (ids.length) await dockerRaw(["rm", "-f", ...ids]);
  const nets = await dockerRaw(["network", "ls", "-q", "--filter", `label=forge.prefix=${PREFIX}`]);
  const netIds = nets.stdout.toString().split("\n").filter(Boolean);
  if (netIds.length) await dockerRaw(["network", "rm", ...netIds]);
}

/** Integration runs start and end with no leftover test containers/networks (prefix "forgetest" only). */
export default async function setup(): Promise<() => Promise<void>> {
  await removeAll();
  return removeAll;
}
