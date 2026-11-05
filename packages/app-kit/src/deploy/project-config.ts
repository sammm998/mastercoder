import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const LooseManifest = z
  .object({ port: z.number().int().optional(), containerPort: z.number().int().optional(), healthPath: z.string().startsWith("/").optional() })
  .passthrough();

/** Container port + health path from a project's forge.json (if present). */
export async function runtimeConfig(dir: string | undefined, input: { port?: number; healthPath?: string }): Promise<{ port: number; healthPath: string }> {
  let m: z.infer<typeof LooseManifest> = {};
  if (dir) {
    try {
      m = LooseManifest.parse(JSON.parse(await readFile(join(dir, "forge.json"), "utf8")));
    } catch {
      m = {};
    }
  }
  return { port: input.port ?? m.containerPort ?? m.port ?? 3000, healthPath: input.healthPath ?? m.healthPath ?? "/" };
}
