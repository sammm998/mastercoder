import { localWriter, scaffold, type FileWriter, type TemplateVars } from "@forge/templates";
import { kitFilesFor, type KitOptions } from "./files.js";
import type { KitFeature } from "./features.js";

export interface FileReader {
  readFile(path: string): Promise<string | null>;
}

/**
 * Install kit features into an existing project: reads its package.json / forge.json /
 * .env.example / requirements.txt so they are merged, not replaced, then writes the kit files.
 */
export async function applyKit(templateId: string, features: readonly KitFeature[], io: FileReader & FileWriter, vars?: TemplateVars): Promise<string[]> {
  const read = async (p: string) => (await io.readFile(p)) ?? undefined;
  const opts: KitOptions = {
    packageJson: await read("package.json"),
    forgeJson: await read("forge.json"),
    envExample: await read(".env.example"),
    requirements: await read("requirements.txt"),
    vars,
  };
  const files = kitFilesFor(templateId, features, opts);
  for (const [p, c] of Object.entries(files)) await io.writeFile(p, c);
  return Object.keys(files);
}

/** Scaffold a template and install kit features in one go, onto a local directory. */
export async function scaffoldWithKit(templateId: string, dir: string, vars: TemplateVars, features: readonly KitFeature[]): Promise<string[]> {
  const writer = localWriter(dir);
  const res = await scaffold(templateId, writer, vars);
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const io = {
    writeFile: writer.writeFile,
    readFile: async (p: string) => {
      try {
        return await readFile(join(dir, p), "utf8");
      } catch {
        return null;
      }
    },
  };
  const kit = features.length ? await applyKit(templateId, features, io, vars) : [];
  return [...new Set([...res.files, ...kit])];
}
