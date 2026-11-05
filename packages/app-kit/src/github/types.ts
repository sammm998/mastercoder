import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ForgeError } from "@forge/shared";
import { isTemplateId, templateDir } from "@forge/templates";

export interface GitExportInput {
  files: Record<string, string | Uint8Array>;
  owner: string;
  repo: string;
  branch: string;
  token: string;
  message: string;
}

export interface GitExportResult {
  commitSha: string;
  commitUrl: string;
  branch: string;
  files: number;
  /** Secret files that were not exported (.env, keys). */
  skipped: string[];
  /** True when a Dockerfile was added from the project's template. */
  addedDockerfile: boolean;
}

export interface GitExporter {
  readonly name: string;
  readonly isMock: boolean;
  export(input: GitExportInput): Promise<GitExportResult>;
}

export const GitExportInputSchema = z.object({
  owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, "invalid GitHub owner"),
  repo: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/, "invalid repository name"),
  branch: z.string().min(1).max(200).regex(/^(?!\/)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]+(?<![/.])$/, "invalid branch name"),
  token: z.string().min(1),
  message: z.string().min(1).max(10_000),
});

const SECRET_FILE = /(^|\/)(\.env(\.(?!example$)[^/]+)?|.*\.(pem|key|p12|p8|jks|mobileprovision)|id_rsa|id_ed25519)$/;

/** Normalise and validate export paths; drop secret files. */
export function sanitizeFiles(files: Record<string, string | Uint8Array>): { files: Record<string, string | Uint8Array>; skipped: string[] } {
  const out: Record<string, string | Uint8Array> = {};
  const skipped: string[] = [];
  for (const [raw, content] of Object.entries(files)) {
    const p = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!p || p.startsWith("/") || p.split("/").some((s) => s === ".." || s === "") || p.startsWith(".git/") || p === ".git") {
      throw new ForgeError("BAD_INPUT", `Invalid export path "${raw}"`);
    }
    if (SECRET_FILE.test(p)) {
      skipped.push(p);
      continue;
    }
    out[p] = content;
  }
  return { files: out, skipped };
}

/**
 * Every export must be deployable: if the project has no Dockerfile, add the one from its template
 * (identified by forge.json `id`), plus the files that Dockerfile copies (nginx.conf, .dockerignore).
 */
export async function ensureDockerfile(files: Record<string, string | Uint8Array>): Promise<{ files: Record<string, string | Uint8Array>; added: boolean }> {
  if (files.Dockerfile !== undefined) return { files, added: false };
  const manifestRaw = files["forge.json"];
  let id: string | undefined;
  try {
    id = manifestRaw ? z.object({ id: z.string() }).passthrough().parse(JSON.parse(typeof manifestRaw === "string" ? manifestRaw : Buffer.from(manifestRaw).toString("utf8"))).id : undefined;
  } catch {
    id = undefined;
  }
  if (!id || !isTemplateId(id)) throw new ForgeError("BAD_INPUT", "Export needs a Dockerfile (none found and forge.json does not name a known template)");
  const dir = templateDir(id);
  const out: Record<string, string | Uint8Array> = { ...files, Dockerfile: await readFile(join(dir, "Dockerfile"), "utf8") };
  for (const extra of [".dockerignore", "nginx.conf"]) {
    if (out[extra] === undefined) {
      try {
        out[extra] = await readFile(join(dir, extra), "utf8");
      } catch {
        // template does not use it
      }
    }
  }
  return { files: out, added: true };
}
