/** Gates against the fixtures inside a REAL Docker sandbox (docker CLI, hardened container, egress proxy). */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { LocalObjectStore } from "@forge/shared";
import { copyDirToSandbox, DockerSandboxProvider, SnapshotStore, type Sandbox } from "@forge/sandbox";
import { runGates, STATIC_GATES } from "../src/index.js";
import { FIXTURES, stubOsv } from "./helpers.js";

const provider = new DockerSandboxProvider({
  prefix: "forgeqg",
  defaultCpu: 1,
  defaultMemoryMb: 512,
  snapshotStore: new SnapshotStore(new LocalObjectStore(mkdtempSync(join(tmpdir(), "qg-int-")))),
});
const created: Sandbox[] = [];

afterAll(async () => {
  for (const sb of created) await sb.destroy();
  await provider.egress.teardown();
  vi.unstubAllGlobals();
});

async function dockerSandbox(fixture: string): Promise<Sandbox> {
  const sb = await provider.create({ projectId: `qg-int-${fixture}-${Date.now().toString(36)}` });
  created.push(sb);
  await copyDirToSandbox(sb, join(FIXTURES, fixture));
  return sb;
}

describe("quality gates in a docker sandbox", () => {
  it("blocks insecure-app on every static gate", async () => {
    stubOsv();
    const sb = await dockerSandbox("insecure-app");
    const report = await runGates(sb, { gates: STATIC_GATES });
    expect(report.blockers.map((b) => b.gate).sort()).toEqual([...STATIC_GATES].sort());
    const rules = report.blockers.flatMap((b) => b.findings.map((f) => `${f.rule}@${f.file}:${f.line}`));
    expect(rules).toEqual(
      expect.arrayContaining([
        "secret/aws-access-key-id@lib/aws.ts:4",
        "owasp/sql-injection@app/api/users/route.ts:7",
        "rls/not-enabled@db/migrations/0001_init.sql:10",
        "auth/missing-check@app/api/users/route.ts:4",
        "validation/unvalidated-input@app/api/notes/route.ts:4",
        "client-secrets/server-env-in-client@app/dashboard/page.tsx:8",
      ]),
    );
  });

  it("passes secure-app and runs project commands inside the container", async () => {
    stubOsv();
    const sb = await dockerSandbox("secure-app");
    await sb.writeFile("forge.json", JSON.stringify({ typecheck: "node -e \"console.log(process.getuid())\"", lint: null, test: null, publicRoutes: ["/api/health"] }));
    const report = await runGates(sb, { gates: [...STATIC_GATES, "typecheck"] });
    expect(report.results.filter((r) => !r.passed).map((r) => `${r.gate}: ${r.details}`)).toEqual([]);
    expect(report.results.find((r) => r.gate === "typecheck")?.details).toMatch(/passed/);
  });
});
