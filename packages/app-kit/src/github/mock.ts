import { createHash } from "node:crypto";
import { selectAdapter } from "@forge/shared";
import { GitHubExporter } from "../adapters/github.js";
import { GitExportInputSchema, ensureDockerfile, sanitizeFiles, type GitExportInput, type GitExportResult, type GitExporter } from "./types.js";

/** git's blob object id: sha1("blob <len>\0<content>"). */
export function gitBlobSha(content: string | Uint8Array): string {
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  return createHash("sha1").update(`blob ${buf.byteLength}\0`).update(buf).digest("hex");
}

/**
 * MOCK exporter: validates and sanitises like the real one, computes real git blob ids, and keeps
 * the snapshot in memory. Nothing is sent to GitHub; commit URLs use `mock.forge.invalid`.
 */
export class MockGitExporter implements GitExporter {
  readonly name = "mock";
  readonly isMock = true;
  readonly exports: Array<{ input: Omit<GitExportInput, "token">; files: Record<string, string>; result: GitExportResult }> = [];

  async export(input: GitExportInput): Promise<GitExportResult> {
    const v = GitExportInputSchema.parse(input);
    const { files: clean, skipped } = sanitizeFiles(input.files);
    const { files, added } = await ensureDockerfile(clean);
    const entries = Object.keys(files)
      .sort()
      .map((p) => `${p}:${gitBlobSha(files[p] as string | Uint8Array)}`);
    const commitSha = createHash("sha1").update(`${v.owner}/${v.repo}@${v.branch}\n${v.message}\n${entries.join("\n")}\n${this.exports.length}`).digest("hex");
    const result: GitExportResult = { commitSha, commitUrl: `https://mock.forge.invalid/${v.owner}/${v.repo}/commit/${commitSha}`, branch: v.branch, files: entries.length, skipped, addedDockerfile: added };
    const text: Record<string, string> = {};
    for (const [p, c] of Object.entries(files)) text[p] = typeof c === "string" ? c : Buffer.from(c).toString("base64");
    this.exports.push({ input: { files: input.files, owner: v.owner, repo: v.repo, branch: v.branch, message: v.message }, files: text, result });
    return result;
  }
}

/** GIT_EXPORT_PROVIDER=github|mock (default mock). */
export function createGitExporter(): GitExporter {
  return selectAdapter<GitExporter>("GIT_EXPORT_PROVIDER", { github: () => new GitHubExporter(), mock: () => new MockGitExporter() }, "mock").instance;
}
