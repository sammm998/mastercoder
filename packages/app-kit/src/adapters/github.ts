import { z } from "zod";
import { ForgeError } from "@forge/shared";
import { GitExportInputSchema, ensureDockerfile, sanitizeFiles, type GitExportInput, type GitExportResult, type GitExporter } from "../github/types.js";

export interface GitHubExportOptions {
  apiUrl?: string;
  fetch?: typeof fetch;
  /** Parallel blob uploads. */
  concurrency?: number;
}

const ShaSchema = z.object({ sha: z.string() });
const RefSchema = z.object({ object: z.object({ sha: z.string() }) });
const RepoSchema = z.object({ default_branch: z.string(), html_url: z.string() });
const CommitSchema = z.object({ sha: z.string(), html_url: z.string().optional() });

class GitHubApi {
  constructor(private readonly base: string, private readonly token: string, private readonly fetchImpl: typeof fetch) {}

  async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "forge-app-kit",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as unknown) : null };
  }

  async ok<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    const r = await this.call(method, path, body);
    if (r.status >= 300) {
      const msg = (r.json as { message?: string } | null)?.message ?? "";
      const code = r.status === 401 ? "UNAUTHORIZED" : r.status === 403 ? "FORBIDDEN" : r.status === 404 ? "NOT_FOUND" : "PROVIDER_ERROR";
      throw new ForgeError(code, `GitHub ${method} ${path}: ${r.status} ${msg}`);
    }
    return schema.parse(r.json);
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Export a project snapshot to GitHub with the git data API: blobs → tree (no base tree, so the
 * commit is exactly `files`) → commit (parent = current branch head) → ref update. Works for new
 * branches and for empty repositories (seeded through the contents API first). `.env` files and
 * private keys are never exported; a Dockerfile is added from the template when missing.
 */
export async function exportToGitHub(input: GitExportInput, opts: GitHubExportOptions = {}): Promise<GitExportResult> {
  const v = GitExportInputSchema.parse(input);
  const { files: clean, skipped } = sanitizeFiles(input.files);
  const { files, added } = await ensureDockerfile(clean);
  const paths = Object.keys(files).sort();
  if (paths.length === 0) throw new ForgeError("BAD_INPUT", "Nothing to export");

  const gh = new GitHubApi((opts.apiUrl ?? "https://api.github.com").replace(/\/$/, ""), v.token, opts.fetch ?? fetch);
  const repoPath = `/repos/${v.owner}/${v.repo}`;
  const branchRef = `heads/${v.branch.split("/").map(encodeURIComponent).join("/")}`;

  const repo = await gh.ok("GET", repoPath, RepoSchema);
  let parent: string | undefined;
  let branchExists = false;
  const head = await gh.call("GET", `${repoPath}/git/ref/${branchRef}`);
  if (head.status === 200) {
    parent = RefSchema.parse(head.json).object.sha;
    branchExists = true;
  } else if (head.status === 409) {
    // Empty repository: the git data API needs at least one commit. Seed one via the contents API.
    await gh.ok("PUT", `${repoPath}/contents/.forge-export`, z.unknown(), { message: "Initialize repository", content: Buffer.from("").toString("base64"), branch: v.branch });
    parent = RefSchema.parse((await gh.call("GET", `${repoPath}/git/ref/${branchRef}`)).json).object.sha;
    branchExists = true;
  } else if (head.status === 404) {
    const base = await gh.call("GET", `${repoPath}/git/ref/heads/${encodeURIComponent(repo.default_branch)}`);
    if (base.status === 200) parent = RefSchema.parse(base.json).object.sha;
    else if (base.status === 409) {
      await gh.ok("PUT", `${repoPath}/contents/.forge-export`, z.unknown(), { message: "Initialize repository", content: Buffer.from("").toString("base64"), branch: v.branch });
      parent = RefSchema.parse((await gh.call("GET", `${repoPath}/git/ref/${branchRef}`)).json).object.sha;
      branchExists = true;
    } else throw new ForgeError("PROVIDER_ERROR", `GitHub: cannot read default branch ${repo.default_branch} (${base.status})`);
  } else {
    throw new ForgeError(head.status === 401 ? "UNAUTHORIZED" : "PROVIDER_ERROR", `GitHub: cannot read branch ${v.branch} (${head.status})`);
  }

  const blobs = await mapLimit(paths, opts.concurrency ?? 8, async (p) => {
    const c = files[p] as string | Uint8Array;
    const content = Buffer.from(typeof c === "string" ? Buffer.from(c, "utf8") : c).toString("base64");
    const { sha } = await gh.ok("POST", `${repoPath}/git/blobs`, ShaSchema, { content, encoding: "base64" });
    const executable = typeof c === "string" && c.startsWith("#!");
    return { path: p, mode: executable ? "100755" : "100644", type: "blob", sha };
  });
  const tree = await gh.ok("POST", `${repoPath}/git/trees`, ShaSchema, { tree: blobs });
  const commit = await gh.ok("POST", `${repoPath}/git/commits`, CommitSchema, { message: v.message, tree: tree.sha, parents: parent ? [parent] : [] });
  if (branchExists) await gh.ok("PATCH", `${repoPath}/git/refs/${branchRef}`, z.unknown(), { sha: commit.sha, force: false });
  else await gh.ok("POST", `${repoPath}/git/refs`, z.unknown(), { ref: `refs/heads/${v.branch}`, sha: commit.sha });

  return {
    commitSha: commit.sha,
    commitUrl: commit.html_url ?? `${repo.html_url}/commit/${commit.sha}`,
    branch: v.branch,
    files: paths.length,
    skipped,
    addedDockerfile: added,
  };
}

export class GitHubExporter implements GitExporter {
  readonly name = "github";
  readonly isMock = false;
  constructor(private readonly opts: GitHubExportOptions = {}) {}
  export(input: GitExportInput): Promise<GitExportResult> {
    return exportToGitHub(input, this.opts);
  }
}
