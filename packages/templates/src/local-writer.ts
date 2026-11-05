import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { FileWriter } from "./registry.js";

/** FileWriter onto a local directory; refuses paths that escape it. */
export function localWriter(rootDir: string): FileWriter {
  const root = resolve(rootDir);
  return {
    async writeFile(path: string, content: string): Promise<void> {
      const full = resolve(root, path);
      if (!full.startsWith(root + sep)) throw new Error(`Path escapes scaffold root: ${path}`);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content);
    },
  };
}
