import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus, ForgeEventSchema } from "@forge/shared";
import { runGates, gateEvents, parseToolOutput, detectProject } from "../src/index.js";
import { sandboxFromFiles, stubOsv } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

describe("command gates", () => {
  it("runs forge.json commands and parses tsc / eslint / generic output into findings", async () => {
    const sb = await sandboxFromFiles({
      "forge.json": JSON.stringify({
        typecheck: "node tc.js",
        lint: "node lint.js",
        test: "echo '2 passed'",
        integration: "sleep 5",
        e2e: null,
      }),
      "tc.js": `console.log("src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'."); process.exit(2);`,
      "lint.js": `console.log("/workspace/src/b.ts\\n  10:5  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any\\n  12:1  warning  Unused  no-unused-vars"); process.exit(1);`,
    });
    const r = await runGates(sb, { gates: ["typecheck", "lint", "unit", "integration", "e2e"], commandTimeoutMs: 1000 });
    const [tc, lint, unit, integ, e2e] = r.results;
    expect(tc).toMatchObject({ gate: "typecheck", passed: false, details: "`node tc.js` failed (exit 2, 1 error(s))" });
    expect(tc?.findings).toEqual([{ file: "src/a.ts", line: 3, rule: "typecheck/TS2322", message: "Type 'string' is not assignable to type 'number'.", severity: "error" }]);
    expect(tc?.fix).toContain("- src/a.ts:3 Type 'string'");
    expect(lint?.findings).toEqual([
      { file: "/workspace/src/b.ts", line: 10, rule: "lint/@typescript-eslint/no-explicit-any", message: "Unexpected any. Specify a different type", severity: "error" },
      { file: "/workspace/src/b.ts", line: 12, rule: "lint/no-unused-vars", message: "Unused", severity: "warning" },
    ]);
    expect(unit).toMatchObject({ passed: true });
    expect(integ).toMatchObject({ passed: false, details: expect.stringContaining("timed out") });
    expect(integ?.fix).toMatch(/hanging/);
    expect(e2e).toMatchObject({ skipped: true, details: "skipped: disabled in forge.json (e2e: null)" });
    expect(r.blockers.map((b) => b.gate)).toEqual(["typecheck", "lint", "integration"]);
    await sb.destroy();
  });

  it("infers commands from package.json scripts and lockfile", async () => {
    const sb = await sandboxFromFiles({
      "package.json": JSON.stringify({ scripts: { typecheck: "tsc", lint: "eslint .", test: "vitest run", "test:e2e": "playwright test" }, dependencies: { next: "15.0.0" } }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });
    const p = await detectProject(sb, ["package.json", "pnpm-lock.yaml"]);
    expect(p).toMatchObject({ language: "node", kind: "nextjs", packageManager: "pnpm" });
    expect(p.commands).toEqual({ typecheck: "pnpm run typecheck", lint: "pnpm run lint", unit: "pnpm run test", integration: null, e2e: "pnpm run test:e2e" });
    expect(p.reasons.integration).toBe("no test:integration script");
    await sb.destroy();
  });

  it("infers python tooling from pyproject.toml", async () => {
    const sb = await sandboxFromFiles({ "pyproject.toml": "[project]\ndependencies=['fastapi','pydantic']\n[tool.ruff]\n[tool.mypy]\n[tool.pytest.ini_options]\n" });
    const p = await detectProject(sb, ["pyproject.toml"]);
    expect(p).toMatchObject({ language: "python", kind: "fastapi", packageManager: "pip" });
    expect(p.commands).toMatchObject({ typecheck: "mypy .", lint: "ruff check .", unit: "pytest -q" });
    await sb.destroy();
  });

  it("reports a missing command with an install fix", async () => {
    const sb = await sandboxFromFiles({ "forge.json": JSON.stringify({ lint: "definitely-not-a-binary-xyz ." }) });
    const r = await runGates(sb, { gates: ["lint"] });
    expect(r.results[0]?.passed).toBe(false);
    expect(r.results[0]?.fix).toMatch(/Install dependencies first/);
    await sb.destroy();
  });

  it("parses pytest and vitest failures", () => {
    expect(parseToolOutput("FAILED tests/test_api.py::test_create - AssertionError: 500 != 201", "unit")).toEqual([
      { file: "tests/test_api.py", rule: "unit/test-failed", message: "test_create failed: AssertionError: 500 != 201", severity: "error" },
    ]);
    expect(parseToolOutput(" FAIL  src/math.test.ts > adds numbers", "unit")[0]).toMatchObject({ file: "src/math.test.ts", message: "failed: adds numbers" });
    expect(parseToolOutput("app/main.py:12: error: Incompatible return value type", "typecheck")[0]).toMatchObject({ file: "app/main.py", line: 12, rule: "typecheck/error" });
  });
});

describe("external tools are used when installed (sandbox PATH)", () => {
  it("semgrep, gitleaks and osv-scanner JSON is parsed", async () => {
    const bin = mkdtempSync(join(tmpdir(), "qg-bin-"));
    const tool = (name: string, script: string): void => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    tool(
      "semgrep",
      `echo '{"results":[{"check_id":"javascript.express.security.audit.xss","path":"src/a.ts","start":{"line":4},"extra":{"message":"XSS","severity":"ERROR"}}],"errors":[]}'`,
    );
    tool(
      "gitleaks",
      `while [ $# -gt 0 ]; do if [ "$1" = "--report-path" ]; then out="$2"; fi; shift; done\nprintf '[{"RuleID":"aws-access-token","File":"/workspace/src/k.ts","StartLine":2,"Description":"AWS","Secret":"REDACTED"}]' > "$out"\nexit 1`,
    );
    tool(
      "osv-scanner",
      `echo '{"results":[{"source":{"path":"/workspace/package-lock.json"},"packages":[{"package":{"name":"minimist","version":"1.2.0","ecosystem":"npm"},"vulnerabilities":[{"id":"GHSA-xvch-5gv4-984h","summary":"Prototype Pollution in minimist"}]}]}]}'; exit 1`,
    );
    const sb = await sandboxFromFiles({ "src/a.ts": "export {}\n" });
    const r = await runGates(sb, { gates: ["semgrep", "gitleaks", "osv"], env: { PATH: `${bin}:${process.env.PATH}` } });
    const [sg, gl, osv] = r.results;
    expect(sg).toMatchObject({ passed: false, details: "semgrep p/owasp-top-ten (sandbox): 1 blocking finding(s)" });
    expect(sg?.findings[0]).toMatchObject({ file: "src/a.ts", line: 4, rule: "semgrep/javascript.express.security.audit.xss" });
    expect(gl).toMatchObject({ passed: false, details: "gitleaks (sandbox): 1 secret(s) found" });
    expect(gl?.findings[0]).toMatchObject({ file: "src/k.ts", line: 2, rule: "gitleaks/aws-access-token" });
    expect(osv?.findings[0]).toMatchObject({ file: "package-lock.json", rule: "osv/GHSA-xvch-5gv4-984h" });
    expect(osv?.fix).toContain("minimist@1.2.0");
    await sb.destroy();
  });
});

describe("osv fallback edge cases", () => {
  it("skips (does not pass silently) when the OSV API is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ENOTFOUND api.osv.dev");
    }));
    const sb = await sandboxFromFiles({ "requirements.txt": "django==3.2.0\n" });
    const r = await runGates(sb, { gates: ["osv"], externalTools: false });
    expect(r.results[0]).toMatchObject({ skipped: true, passed: true });
    expect(r.results[0]?.details).toMatch(/OSV API .* unreachable/);
    await sb.destroy();
  });

  it("skips when there are no dependency manifests", async () => {
    stubOsv();
    const sb = await sandboxFromFiles({ "index.html": "<h1>hi</h1>" });
    const r = await runGates(sb, { gates: ["osv", "rls", "auth", "validation", "client-secrets"], externalTools: false });
    expect(r.results.every((x) => x.skipped)).toBe(true);
    expect(r.passed).toBe(true);
    await sb.destroy();
  });
});

describe("validation / auth / client-secrets on other frameworks", () => {
  it("FastAPI: pydantic body passes, raw request.json() fails; Depends auth recognised", async () => {
    const sb = await sandboxFromFiles({
      "pyproject.toml": "[project]\ndependencies=['fastapi']\n",
      "app/main.py": [
        "from fastapi import FastAPI, Depends, Request",
        "from pydantic import BaseModel",
        "app = FastAPI()",
        "class NoteIn(BaseModel):",
        "    title: str",
        "",
        '@app.post("/notes")',
        "async def create(note: NoteIn, user=Depends(get_current_user)):",
        "    return note",
        "",
        '@app.put("/raw")',
        "async def raw(request: Request):",
        "    data = await request.json()",
        "    return data",
      ].join("\n"),
    });
    const r = await runGates(sb, { gates: ["auth", "validation"], externalTools: false });
    const [auth, val] = r.results;
    expect(auth?.findings.map((f) => f.message)).toEqual(["PUT /raw has no authentication check and is not marked public"]);
    expect(auth?.fix).toMatch(/Depends\(get_current_user\)/);
    expect(val?.findings.map((f) => `${f.file}:${f.line}`)).toEqual(["app/main.py:11"]);
    expect(val?.fix).toMatch(/Pydantic model/);
    await sb.destroy();
  });

  it("Hono: zValidator + auth middleware pass", async () => {
    const sb = await sandboxFromFiles({
      "package.json": JSON.stringify({ dependencies: { hono: "4.0.0" } }),
      "src/index.ts": [
        `import { Hono } from "hono";`,
        `const app = new Hono();`,
        `app.use("/api/*", bearerAuth({ token }));`,
        `app.post("/api/items", zValidator("json", Item), async (c) => c.json(await c.req.json()));`,
      ].join("\n"),
    });
    const r = await runGates(sb, { gates: ["auth", "validation"], externalTools: false });
    expect(r.passed).toBe(true);
    await sb.destroy();
  });

  it("Vite client code and built bundles", async () => {
    const sb = await sandboxFromFiles({
      "package.json": JSON.stringify({ dependencies: { vite: "5.0.0" } }),
      "vite.config.ts": "export default {}",
      "src/main.ts": "const url = import.meta.env.VITE_API_URL;\nconst key = import.meta.env.OPENAI_API_KEY;\nconst ok = import.meta.env.MODE;\nconst bad = import.meta.env.VITE_SERVICE_ROLE_KEY;",
      "dist/assets/index-abc.js": `var e="${"sk_" + "live_" + "51HxQp8Rt3vYWb2Nc5Md"}";console.log(e)`,
    });
    const r = await runGates(sb, { gates: ["client-secrets"], externalTools: false });
    const rules = r.results[0]?.findings.map((f) => `${f.file}:${f.line ?? 0}:${f.rule}`).sort();
    expect(rules).toEqual([
      "dist/assets/index-abc.js:1:client-secrets/stripe-secret-key",
      "src/main.ts:2:client-secrets/server-env-in-client",
      "src/main.ts:4:client-secrets/secret-with-public-prefix",
    ]);
    await sb.destroy();
  });
});

describe("lighthouse and visual-qa", () => {
  it("applies thresholds (accepts 0..1 or 0..100 scores) and proposes fixes", async () => {
    const sb = await sandboxFromFiles({});
    const lighthouse = vi.fn(async () => ({ performance: 0.72, accessibility: 95 }));
    const r = await runGates(sb, { gates: ["lighthouse", "visual-qa"], previewUrl: "http://127.0.0.1:3000", lighthouse, visualScore: 7.5 });
    expect(lighthouse).toHaveBeenCalledWith("http://127.0.0.1:3000");
    // No build/preview scripts: measured on the dev server, where performance is reported but not enforced.
    expect(r.results[0]).toMatchObject({ passed: true, details: "performance 72 (>= 0, dev server — not enforced), accessibility 95 (>= 90) for http://127.0.0.1:3000" });
    const badA11y = await runGates(sb, { gates: ["lighthouse"], previewUrl: "http://127.0.0.1:3000", lighthouse: async () => ({ performance: 99, accessibility: 70 }) });
    expect(badA11y.results[0]?.findings.map((f) => f.rule)).toEqual(["lighthouse/accessibility"]);
    expect(r.results[1]).toMatchObject({ passed: false, details: "visual QA score 7.5 < 8" });
    const ok = await runGates(sb, { gates: ["lighthouse", "visual-qa"], previewUrl: "http://x", lighthouse: async () => ({ performance: 90, accessibility: 0.92 }), visualScore: 8 });
    expect(ok.passed).toBe(true);
    const skippedRun = await runGates(sb, { gates: ["lighthouse"], lighthouse });
    expect(skippedRun.results[0]).toMatchObject({ skipped: true, details: "skipped: no previewUrl" });
    await sb.destroy();
  });

  it("measures the production build when the project has build + preview scripts", async () => {
    const server = `const http=require("http");const a=process.argv;const port=Number(a[a.indexOf("--port")+1]);http.createServer((q,r)=>r.end("prod")).listen(port,"127.0.0.1");`;
    const sb = await sandboxFromFiles({ "package.json": JSON.stringify({ scripts: { build: "node -e 0", preview: "node prod.cjs" } }), "prod.cjs": server });
    const urls: string[] = [];
    const r = await runGates(sb, { gates: ["lighthouse"], previewUrl: "http://127.0.0.1:3000", lighthouse: async (u) => (urls.push(u), { performance: 0.72, accessibility: 95 }) });
    expect(urls[0]).toMatch(/:4\d{4}$/);
    expect(r.results[0]).toMatchObject({ passed: false, details: "performance 72 (>= 85), accessibility 95 (>= 90) for production build" });
    expect(r.results[0]?.fix).toMatch(/never delete them/);
    await sb.destroy();
  }, 60_000);

  it("a browser gate that cannot run is reported as skipped with the reason, never as passed", async () => {
    const sb = await sandboxFromFiles({});
    const r = await runGates(sb, { gates: ["lighthouse"], previewUrl: "http://x", lighthouse: async () => Promise.reject(new Error("chrome not found")) });
    expect(r.results[0]).toMatchObject({ gate: "lighthouse", passed: false, skipped: true });
    expect(r.results[0]?.details).toMatch(/could not run in this environment \(chrome not found\)/);
    expect(r.blockers).toHaveLength(0);
    await sb.destroy();
  });
});

describe("gateEvents", () => {
  it("produces valid gate.result ForgeEvents", async () => {
    const sb = await sandboxFromFiles({});
    const report = await runGates(sb, { gates: ["visual-qa"], visualScore: 3 });
    const bus = new EventBus();
    for (const e of gateEvents(report, "proj_1", "task_1")) bus.emit(e);
    const [evt] = bus.ofType("gate.result");
    expect(ForgeEventSchema.parse(evt)).toMatchObject({ gate: "visual-qa", passed: false, projectId: "proj_1", fix: expect.any(String) });
    await sb.destroy();
  });
});
