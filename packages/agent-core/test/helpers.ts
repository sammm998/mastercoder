import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { SandboxPort, TemplatesPort, GatesPort, GateReportLike } from "../src/index.js";

/** Test-only sandbox over a temp directory (no isolation). */
export class TempDirSandbox implements SandboxPort {
  readonly id = `tmp_${Math.random().toString(36).slice(2)}`;
  readonly workdir: string;
  private snaps = new Map<string, string>();
  constructor(readonly projectId = "prj_test") {
    this.workdir = mkdtempSync(join(tmpdir(), "forge-agent-"));
  }
  exec(cmd: string, opts: { timeoutMs?: number } = {}) {
    const start = Date.now();
    return new Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number; timedOut: boolean }>((resolve) => {
      execFile("bash", ["-lc", cmd], { cwd: this.workdir, timeout: opts.timeoutMs ?? 60_000 }, (err, stdout, stderr) => {
        const e = err as (Error & { code?: number; killed?: boolean }) | null;
        resolve({ exitCode: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr, durationMs: Date.now() - start, timedOut: Boolean(e?.killed) });
      });
    });
  }
  async readFile(p: string) {
    return readFile(join(this.workdir, p), "utf8");
  }
  async writeFile(p: string, c: string | Uint8Array) {
    await mkdir(dirname(join(this.workdir, p)), { recursive: true });
    await writeFile(join(this.workdir, p), c);
  }
  async listFiles(dir = ".") {
    const out: string[] = [];
    const walk = async (d: string) => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        const full = join(d, e.name);
        if (e.isDirectory()) await walk(full);
        else out.push(relative(this.workdir, full));
      }
    };
    await walk(join(this.workdir, dir));
    return out.sort();
  }
  async snapshot() {
    const id = `snap_${this.snaps.size + 1}`;
    const dest = mkdtempSync(join(tmpdir(), "forge-snap-"));
    await cp(this.workdir, dest, { recursive: true });
    this.snaps.set(id, dest);
    return { snapshotId: id };
  }
  async restore(id: string) {
    const src = this.snaps.get(id);
    if (!src) throw new Error("no snapshot");
    await rm(this.workdir, { recursive: true, force: true });
    await cp(src, this.workdir, { recursive: true });
  }
  async exposePort(port: number) {
    return { url: `http://127.0.0.1:${port}` };
  }
}

export const fakeTemplates: TemplatesPort = {
  select: () => "node-basic",
  manifest: () => ({ id: "node-basic", kind: "backend", install: "true", dev: "true", test: "node test.js", port: 3999 }),
  scaffold: async (_id, w) => {
    await w.writeFile("package.json", JSON.stringify({ name: "x", type: "module", scripts: { test: "node test.js" } }));
    await w.writeFile("forge.json", JSON.stringify({ id: "node-basic" }));
    await w.writeFile("test.js", 'import { add } from "./src/math.js"; if (add(2, 3) !== 5) { console.error("add broken"); process.exit(1); } console.log("ok");');
    return ["package.json", "forge.json", "test.js"];
  },
};

/** Gates that really run the project's test command in the sandbox. */
export const testGates: GatesPort = {
  async run(sandbox): Promise<GateReportLike> {
    const r = await sandbox.exec("node test.js");
    const result = { gate: "unit", passed: r.exitCode === 0, details: (r.stdout + r.stderr).trim(), findings: r.exitCode === 0 ? [] : [{ rule: "test", message: r.stderr.trim() || "tests failed", severity: "error" as const }], fix: r.exitCode === 0 ? undefined : "Fix src/math.js so add() returns the sum" };
    return { passed: result.passed, results: [result], blockers: result.passed ? [] : [result] };
  },
};
