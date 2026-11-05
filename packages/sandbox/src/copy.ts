import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Sandbox } from "./types.js";

/** Copy a host directory into a sandbox (any provider) under `dest` (default /workspace). Returns copied paths. */
export async function copyDirToSandbox(
  sandbox: Sandbox,
  hostDir: string,
  dest = sandbox.workdir,
  opts: { exclude?: string[] } = {},
): Promise<string[]> {
  const exclude = new Set(opts.exclude ?? ["node_modules", ".git"]);
  const copied: string[] = [];
  const walk = async (abs: string, rel: string): Promise<void> => {
    for (const e of await readdir(abs, { withFileTypes: true })) {
      if (exclude.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(abs, e.name), r);
      else if (e.isFile()) {
        await sandbox.writeFile(`${dest}/${r}`, new Uint8Array(await readFile(join(abs, e.name))));
        copied.push(r);
      }
    }
  };
  await walk(hostDir, "");
  return copied.sort();
}
