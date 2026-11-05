import { describe, expect, it } from "vitest";
import { MockGitExporter, ensureDockerfile, exportToGitHub, gitBlobSha, sanitizeFiles } from "../src/index.js";

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

function ghStub(opts: { branch: "exists" | "missing" | "empty" }) {
  const calls: Call[] = [];
  let seeded = false;
  let blob = 0;
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path: u.pathname, body });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    const p = u.pathname.replace("/repos/acme/site", "");
    if (p === "") return json({ default_branch: "main", html_url: "https://github.com/acme/site" });
    if (method === "GET" && p.startsWith("/git/ref/heads/")) {
      if (opts.branch === "empty" && !seeded) return json({ message: "Git Repository is empty." }, 409);
      if (opts.branch === "missing" && p.endsWith("/forge-export")) return json({ message: "Not Found" }, 404);
      return json({ object: { sha: seeded ? "seedsha" : "headsha" } });
    }
    if (method === "PUT" && p.startsWith("/contents/")) {
      seeded = true;
      return json({ content: {} }, 201);
    }
    if (method === "POST" && p === "/git/blobs") return json({ sha: `blob${++blob}` }, 201);
    if (method === "POST" && p === "/git/trees") return json({ sha: "treesha" }, 201);
    if (method === "POST" && p === "/git/commits") return json({ sha: "commitsha", html_url: "https://github.com/acme/site/commit/commitsha" }, 201);
    if (method === "PATCH" && p.startsWith("/git/refs/heads/")) return json({ object: { sha: "commitsha" } });
    if (method === "POST" && p === "/git/refs") return json({ ref: body?.ref }, 201);
    return json({ message: `unhandled ${method} ${p}` }, 500);
  }) as typeof fetch;
  return { calls, fetch: f };
}

const files = {
  "forge.json": JSON.stringify({ id: "hono-api" }),
  "src/index.ts": "console.log('hi')\n",
  "scripts/run.sh": "#!/bin/sh\necho hi\n",
  ".env": "SECRET=1\n",
  ".env.example": "PORT=3000\n",
};

describe("exportToGitHub", () => {
  it("commits blobs → tree → commit → ref on an existing branch, adding the template Dockerfile", async () => {
    const s = ghStub({ branch: "exists" });
    const r = await exportToGitHub({ files, owner: "acme", repo: "site", branch: "main", token: "ghp_x", message: "Export from Forge" }, { fetch: s.fetch });
    expect(r).toMatchObject({ commitSha: "commitsha", branch: "main", addedDockerfile: true, skipped: [".env"] });
    const tree = s.calls.find((c) => c.path.endsWith("/git/trees"))?.body as { tree: Array<{ path: string; mode: string }>; base_tree?: string };
    expect(tree.base_tree).toBeUndefined();
    expect(tree.tree.map((t) => t.path)).toEqual([".dockerignore", ".env.example", "Dockerfile", "forge.json", "scripts/run.sh", "src/index.ts"]);
    expect(tree.tree.find((t) => t.path === "scripts/run.sh")?.mode).toBe("100755");
    expect(s.calls.find((c) => c.path.endsWith("/git/commits"))?.body).toEqual({ message: "Export from Forge", tree: "treesha", parents: ["headsha"] });
    expect(s.calls.at(-1)).toMatchObject({ method: "PATCH", body: { sha: "commitsha", force: false } });
  });

  it("creates a new branch from the default branch head", async () => {
    const s = ghStub({ branch: "missing" });
    await exportToGitHub({ files, owner: "acme", repo: "site", branch: "forge-export", token: "t", message: "m" }, { fetch: s.fetch });
    expect(s.calls.at(-1)).toMatchObject({ method: "POST", path: "/repos/acme/site/git/refs", body: { ref: "refs/heads/forge-export", sha: "commitsha" } });
  });

  it("seeds an empty repository before using the git data API", async () => {
    const s = ghStub({ branch: "empty" });
    await exportToGitHub({ files, owner: "acme", repo: "site", branch: "main", token: "t", message: "m" }, { fetch: s.fetch });
    expect(s.calls.some((c) => c.method === "PUT" && c.path.includes("/contents/"))).toBe(true);
    expect((s.calls.find((c) => c.path.endsWith("/git/commits"))?.body as { parents: string[] }).parents).toEqual(["seedsha"]);
  });

  it("validates inputs and refuses exports without a Dockerfile source", async () => {
    await expect(exportToGitHub({ files: { "a.txt": "x" }, owner: "acme", repo: "site", branch: "main", token: "t", message: "m" })).rejects.toThrow(/Dockerfile/);
    await expect(exportToGitHub({ files, owner: "a/b", repo: "site", branch: "main", token: "t", message: "m" })).rejects.toThrow();
    await expect(exportToGitHub({ files, owner: "acme", repo: "site", branch: "../x", token: "t", message: "m" })).rejects.toThrow();
    expect(() => sanitizeFiles({ "../etc/passwd": "x" })).toThrow(/Invalid export path/);
    expect(sanitizeFiles({ "certs/server.key": "x", "src/a.ts": "y" }).skipped).toEqual(["certs/server.key"]);
  });

  it("keeps an existing Dockerfile", async () => {
    const r = await ensureDockerfile({ Dockerfile: "FROM scratch\n" });
    expect(r.added).toBe(false);
  });
});

describe("MockGitExporter", () => {
  it("computes real git blob ids and records the snapshot", async () => {
    expect(gitBlobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    const m = new MockGitExporter();
    const r = await m.export({ files, owner: "acme", repo: "site", branch: "main", token: "t", message: "m" });
    expect(r.commitUrl).toContain("mock.forge.invalid");
    expect(m.exports[0]?.files.Dockerfile).toMatch(/^# syntax=docker/);
    expect(m.exports[0]?.files[".env"]).toBeUndefined();
  });
});
