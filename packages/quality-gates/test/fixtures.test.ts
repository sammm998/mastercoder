import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Sandbox } from "@forge/sandbox";
import { runGates, formatGateReport, STATIC_GATES, type GateReport, type GateResult } from "../src/index.js";
import { sandboxWith, stubOsv } from "./helpers.js";

const byGate = (r: GateReport, g: string): GateResult => r.results.find((x) => x.gate === g)!;

describe("insecure-app fixture is BLOCKED with specific findings", () => {
  let sb: Sandbox;
  let report: GateReport;
  let fetchMock: ReturnType<typeof stubOsv>;

  beforeAll(async () => {
    fetchMock = stubOsv();
    sb = await sandboxWith("insecure-app");
    report = await runGates(sb, { externalTools: false });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await sb.destroy();
  });

  it("is blocked by every static security gate, each with a fix", () => {
    expect(report.passed).toBe(false);
    expect(report.blockers.map((b) => b.gate).sort()).toEqual([...STATIC_GATES].sort());
    for (const b of report.blockers) {
      expect(b.fix, b.gate).toBeTruthy();
      expect(b.findings.some((f) => f.severity === "error" && f.file && f.line), b.gate).toBe(true);
    }
  });

  it("gitleaks: hardcoded AWS keys (built-in scanner, says so)", () => {
    const g = byGate(report, "gitleaks");
    expect(g.details).toMatch(/gitleaks not installed — used Forge built-in secret rules/);
    expect(g.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: "lib/aws.ts", line: 4, rule: "secret/aws-access-key-id" }),
        expect.objectContaining({ file: "lib/aws.ts", line: 5, rule: "secret/aws-secret-access-key" }),
      ]),
    );
    expect(JSON.stringify(g.findings)).not.toContain("Zq4tY8vB2nK6mR1xW9pL3sD7fH0jG5cA2eU8iO4k");
    expect(g.fix).toMatch(/ROTATE/);
  });

  it("semgrep: SQL injection (built-in OWASP rules)", () => {
    const g = byGate(report, "semgrep");
    expect(g.details).toMatch(/semgrep not installed/);
    expect(g.findings).toEqual([expect.objectContaining({ file: "app/api/users/route.ts", line: 7, rule: "owasp/sql-injection", severity: "error" })]);
    expect(g.fix).toMatch(/parameterized query/);
  });

  it("osv: vulnerable lodash via the OSV batch API", () => {
    const g = byGate(report, "osv");
    expect(g.details).toMatch(/osv-scanner not installed — checked 4 dependencies against the OSV API/);
    expect(g.findings.map((f) => f.rule).sort()).toEqual(["osv/GHSA-35jh-r3h4-6jhm", "osv/GHSA-p6mc-m468-83gw"]);
    expect(g.findings[0]).toMatchObject({ file: "package-lock.json", line: 17 });
    expect(g.fix).toContain("Upgrade lodash 4.17.15 → 4.17.21");
    expect(fetchMock).toHaveBeenCalledWith("https://api.osv.dev/v1/querybatch", expect.objectContaining({ method: "POST" }));
  });

  it("rls: notes (SQL) and audit_log (Drizzle) lack row level security", () => {
    const g = byGate(report, "rls");
    expect(g.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: "db/migrations/0001_init.sql", line: 10, rule: "rls/not-enabled", message: expect.stringContaining('"notes"') }),
        expect.objectContaining({ file: "db/schema.ts", line: 4, rule: "rls/not-enabled", message: expect.stringContaining('"audit_log"') }),
      ]),
    );
    expect(g.findings).toHaveLength(2);
    expect(g.fix).toContain("ALTER TABLE notes ENABLE ROW LEVEL SECURITY;");
    expect(g.fix).toContain("CREATE POLICY notes_owner_all ON notes FOR ALL USING (user_id = ");
  });

  it("auth: unauthenticated non-public routes (public health route is allowed)", () => {
    const g = byGate(report, "auth");
    expect(g.findings.map((f) => `${f.file}:${f.line}`).sort()).toEqual(["app/api/notes/route.ts:4", "app/api/users/route.ts:4"]);
    expect(g.findings.map((f) => f.message).join(" ")).toContain("GET /api/users");
    expect(g.details).toMatch(/2 of 3 handler/);
    expect(g.fix).toMatch(/await auth\(\)/);
  });

  it("validation: unvalidated POST", () => {
    const g = byGate(report, "validation");
    expect(g.findings).toEqual([expect.objectContaining({ file: "app/api/notes/route.ts", line: 4, rule: "validation/unvalidated-input" })]);
    expect(g.fix).toMatch(/safeParse/);
  });

  it("client-secrets: server secret used in a client component", () => {
    const g = byGate(report, "client-secrets");
    expect(g.findings).toEqual([
      expect.objectContaining({ file: "app/dashboard/page.tsx", line: 8, rule: "client-secrets/server-env-in-client", message: expect.stringContaining("STRIPE_SECRET_KEY") }),
    ]);
  });

  it("command and preview gates are skipped with reasons", () => {
    for (const gate of ["typecheck", "lint", "unit", "integration", "e2e"]) {
      const g = byGate(report, gate);
      expect(g.skipped, gate).toBe(true);
      expect(g.details).toMatch(/^skipped: no /);
    }
    expect(byGate(report, "lighthouse").skipped).toBe(true);
    expect(byGate(report, "visual-qa").skipped).toBe(true);
  });

  it("formats a markdown summary with blockers and fixes", () => {
    const md = formatGateReport(report);
    expect(md).toContain("## Quality gates: ❌ blocked (7 failing)");
    expect(md).toContain("| rls | ❌ fail |");
    expect(md).toContain("`lib/aws.ts:4` **secret/aws-access-key-id**");
    expect(md).toContain("**Proposed fix**");
  });
});

describe("secure-app fixture passes all static gates", () => {
  let sb: Sandbox;
  afterEach(() => vi.unstubAllGlobals());

  it("passes semgrep, gitleaks, osv, rls, auth, validation, client-secrets", async () => {
    stubOsv();
    sb = await sandboxWith("secure-app");
    const report = await runGates(sb, { gates: STATIC_GATES, externalTools: false });
    const failing = report.results.filter((r) => !r.passed);
    expect(failing.map((f) => `${f.gate}: ${f.details} ${JSON.stringify(f.findings)}`)).toEqual([]);
    expect(report.passed).toBe(true);
    for (const r of report.results) expect(r.skipped, r.gate).toBeFalsy();
    expect(report.results.find((r) => r.gate === "auth")?.details).toMatch(/4 handler\(s\): all authenticated or public \(1 public\)/);
    expect(report.results.find((r) => r.gate === "rls")?.details).toMatch(/3 table/);
    expect(formatGateReport(report)).toContain("✅ passed");
    await sb.destroy();
  });

  it("commands disabled in forge.json are skipped with that reason", async () => {
    stubOsv();
    sb = await sandboxWith("secure-app");
    const report = await runGates(sb, { gates: ["typecheck", "lint", "unit", "e2e"] });
    expect(report.results.map((r) => r.details)).toEqual([
      "skipped: disabled in forge.json (typecheck: null)",
      "skipped: disabled in forge.json (lint: null)",
      "skipped: disabled in forge.json (test: null)",
      "skipped: no test:e2e / e2e script",
    ]);
    await sb.destroy();
  });
});
