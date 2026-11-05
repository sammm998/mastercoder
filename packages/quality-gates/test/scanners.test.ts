import { describe, expect, it } from "vitest";
import { findSecrets, shannonEntropy } from "../src/scanners/secrets.js";
import { scanOwasp } from "../src/scanners/owasp.js";
import { collectDependencies } from "../src/scanners/osv.js";
import { findRoutes, matchesPublicRoute } from "../src/scanners/routes.js";
import { analyzeRls } from "../src/gates/static.js";
import type { SourceFile } from "../src/files.js";

const file = (path: string, content: string): SourceFile => ({ path, content, lines: content.split("\n") });
// Built at runtime so no secret-looking literal sits in this repo's source.
const j = (...p: string[]): string => p.join("");

describe("secret scanner", () => {
  const cases: Array<[string, string]> = [
    ["aws-access-key-id", `const k = "${j("AKIA", "Z7Q3", "X9VB", "2KDL", "MNP4")}";`],
    ["stripe-secret-key", `stripe = new Stripe("${j("sk_", "live_", "51Hx", "Qp8Rt3vY", "Wb2Nc5Md")}")`],
    ["stripe-secret-key", `const t = '${j("sk_", "test_", "4eC39Hq", "LyjWDarj", "tT1zdp7dc")}'`],
    ["github-token", `token: ${j("ghp_", "a1B2c3D4e5F6g7H8i9J0", "k1L2m3N4o5P6q7R8")}`],
    ["slack-token", `SLACK=${j("xoxb-", "123456789012-", "abcdefABCDEF")}`],
    ["slack-webhook", j("https://hooks.slack.com/services/", "T0ABCDEF/", "B0ABCDEF/", "a1b2c3d4e5f6g7h8i9j0")],
    ["openai-api-key", `OPENAI_API_KEY="${j("sk-proj-", "a".repeat(10), "Zx9", "T3BlbkFJ", "Qw8e7r6t5y4u3i2o1p0a")}"`],
    ["anthropic-api-key", `key = "${j("sk-ant-", "api03-", "Ab3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5hJ7kL9")}"`],
    ["private-key", j("-----BEGIN ", "RSA PRIVATE KEY-----")],
    ["jwt-secret", `const JWT_SECRET = "${j("s3cr3t-", "signing-", "Kq9")}";`],
    ["generic-secret-assignment", `const apiKey = "${j("Xk29Lq", "Pv81Zr", "Tm47Ws", "Nc03")}";`],
  ];
  it.each(cases)("detects %s", (rule, line) => {
    const hits = findSecrets([file("src/x.ts", line)]);
    expect(hits.map((h) => h.rule.id)).toContain(rule);
  });

  it("ignores placeholders, env lookups, allow markers, example env files and lockfiles", () => {
    const content = [
      `const apiKey = process.env.API_KEY;`,
      `const password = "changeme-changeme-123";`,
      `const token = "\${TOKEN_FROM_ENV_PLACEHOLDER}";`,
      `const secret = "your-secret-goes-here-please";`,
      `const apiKey = "${j("Xk29Lq", "Pv81Zr", "Tm47Ws", "Nc03")}"; // gitleaks:allow`,
      `const label = "aaaaaaaaaaaaaaaaaaaaaaaa"; // low entropy`,
    ].join("\n");
    expect(findSecrets([file("src/ok.ts", content)])).toEqual([]);
    expect(findSecrets([file(".env.example", `STRIPE_KEY=${j("sk_", "live_", "51HxQp8Rt3vYWb2Nc5Md")}`)])).toEqual([]);
    expect(findSecrets([file("package-lock.json", `"integrity": "${j("sk_", "live_", "51HxQp8Rt3vYWb2Nc5Md")}"`)])).toEqual([]);
    expect(findSecrets([file(".env", `STRIPE_KEY=${j("sk_", "live_", "51HxQp8Rt3vYWb2Nc5Md")}`)])).toHaveLength(1);
  });

  it("computes entropy", () => {
    expect(shannonEntropy("aaaa")).toBe(0);
    expect(shannonEntropy("abcd")).toBe(2);
  });
});

describe("OWASP built-in rules", () => {
  const rules = (path: string, content: string): string[] => scanOwasp([file(path, content)]).map((h) => `${h.rule}@${h.line}`);

  it("JS/TS positives", () => {
    const src = [
      /* 1 */ `import { exec } from "child_process";`,
      /* 2 */ `export async function GET(req) {`,
      /* 3 */ `  await db.query(\`SELECT * FROM t WHERE id = \${req.query.id}\`);`,
      /* 4 */ `  await db.query("SELECT * FROM t WHERE id = " + req.query.id);`,
      /* 5 */ `  eval(req.body.code);`,
      /* 6 */ `  const f = new Function("a", req.body.src);`,
      /* 7 */ `  exec(\`convert \${req.query.file} out.png\`);`,
      /* 8 */ `  el.innerHTML = req.body.html;`,
      /* 9 */ `  const agent = new https.Agent({ rejectUnauthorized: false });`,
      /* 10 */ `  const t = jwt.sign({ sub: 1 }, "hardcoded-secret");`,
      /* 11 */ `  res.redirect(req.query.next);`,
      /* 12 */ `  return <div dangerouslySetInnerHTML={{ __html: post.body }} />;`,
      /* 13 */ `}`,
      /* 14 */ `app.use(cors({ origin: "*", credentials: true }));`,
    ].join("\n");
    expect(rules("src/server.tsx", src)).toEqual(
      expect.arrayContaining([
        "owasp/sql-injection@3",
        "owasp/sql-injection@4",
        "owasp/eval@5",
        "owasp/new-function@6",
        "owasp/command-injection@7",
        "owasp/xss-inner-html@8",
        "owasp/tls-verification-disabled@9",
        "owasp/hardcoded-jwt-secret@10",
        "owasp/open-redirect@11",
        "owasp/xss-dangerously-set-inner-html@12",
        "owasp/cors-wildcard-credentials@14",
      ]),
    );
  });

  it("JS/TS negatives: parameterized/tagged SQL, sanitized HTML, execFile, regex exec, UI text", () => {
    const src = [
      `import { execFile } from "child_process";`,
      `const r = await db.query("SELECT * FROM t WHERE id = $1", [id]);`,
      "const q = sql`SELECT * FROM t WHERE id = ${id}`;",
      "const label = `Select a file from ${dir}`;",
      `execFile("convert", [file, "out.png"]);`,
      `const m = /x/.exec(input);`,
      `el.innerHTML = DOMPurify.sanitize(html);`,
      `el.innerHTML = "<b>static</b>";`,
      `<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(post.body) }} />`,
      `app.use(cors({ origin: ["https://app.example.com"], credentials: true }));`,
      `// eval(x) in a comment`,
      `await redis.eval(script, 0);`,
    ].join("\n");
    expect(rules("src/ok.tsx", src)).toEqual([]);
  });

  it("Python positives and negatives", () => {
    const src = [
      /* 1 */ `cur.execute(f"SELECT * FROM users WHERE name = '{name}'")`,
      /* 2 */ `cur.execute("SELECT * FROM users WHERE id = %s" % uid)`,
      /* 3 */ `subprocess.run(cmd, shell=True)`,
      /* 4 */ `data = pickle.loads(blob)`,
      /* 5 */ `cfg = yaml.load(text)`,
      /* 6 */ `requests.get(url, verify=False)`,
      /* 7 */ `os.system(f"rm {path}")`,
      /* 8 */ `cur.execute("SELECT * FROM users WHERE id = %s", (uid,))`,
      /* 9 */ `cfg = yaml.load(text, Loader=yaml.SafeLoader)`,
      /* 10 */ `cfg = yaml.safe_load(text)`,
      /* 11 */ `subprocess.run(["ls", path], check=True)`,
    ].join("\n");
    expect(rules("app/main.py", src)).toEqual([
      "owasp/sql-injection@1",
      "owasp/sql-injection@2",
      "owasp/command-injection@3",
      "owasp/insecure-deserialization@4",
      "owasp/yaml-load@5",
      "owasp/tls-verification-disabled@6",
      "owasp/command-injection@7",
    ]);
  });

  it("skips tests and build output", () => {
    expect(rules("src/a.test.ts", `eval(x)`)).toEqual([]);
    expect(rules("dist/assets/index.js", `eval(x)`)).toEqual([]);
  });
});

describe("dependency collection", () => {
  it("parses npm, pnpm, yarn, requirements and poetry lockfiles", () => {
    const deps = collectDependencies([
      file("pnpm-lock.yaml", ["lockfileVersion: '9.0'", "", "packages:", "", "  lodash@4.17.15:", "    resolution: {integrity: x}", "", "  '@babel/core@7.24.0':", "    resolution: {}", "snapshots:", "  ignored@1.0.0: {}"].join("\n")),
      file("web/yarn.lock", ['"minimist@^1.2.0", minimist@^1.2.5:', '  version "1.2.5"', "", "\"@scope/pkg@^2.0.0\":", '  version "2.1.0"'].join("\n")),
      file("api/requirements.txt", ["django==3.2.0", "requests>=2", "pyyaml[extra]==5.3  # pinned"].join("\n")),
      file("svc/poetry.lock", ['[[package]]', 'name = "jinja2"', 'version = "2.10"', "", '[[package]]', 'name = "flask"', 'version = "1.0"'].join("\n")),
      file("tools/package.json", JSON.stringify({ dependencies: { axios: "^0.21.0", local: "file:../x" } })),
    ]);
    const ids = deps.map((d) => `${d.ecosystem}:${d.name}@${d.version}`).sort();
    expect(ids).toEqual(
      [
        "PyPI:django@3.2.0",
        "PyPI:flask@1.0",
        "PyPI:jinja2@2.10",
        "PyPI:pyyaml@5.3",
        "npm:@babel/core@7.24.0",
        "npm:@scope/pkg@2.1.0",
        "npm:axios@0.21.0",
        "npm:lodash@4.17.15",
        "npm:minimist@1.2.5",
      ].sort(),
    );
    expect(deps.find((d) => d.name === "axios")?.approximate).toBe(true);
    expect(deps.find((d) => d.name === "lodash")?.line).toBe(5);
  });
});

describe("route discovery", () => {
  it("finds Express/Hono/Fastify routes and middleware coverage", () => {
    const express = file(
      "server/index.ts",
      [
        `import express from "express";`,
        `const app = express();`,
        `app.get("/health", (req, res) => res.send("ok")); // forge:public`,
        `app.get("/me", requireAuth, (req, res) => res.json(req.user));`,
        `app.post("/items", (req, res) => { db.insert(req.body); res.sendStatus(201); });`,
        `app.use("/admin", authenticate);`,
        `app.delete("/admin/items/:id", (req, res) => res.sendStatus(204));`,
        `app.get("/open", (req, res) => res.send("x"));`,
      ].join("\n"),
    );
    const routes = findRoutes([express]);
    const summary = routes.map((r) => `${r.method} ${r.path} public=${r.publicMarker} mw=${r.coveredByMiddleware}`);
    expect(summary).toEqual([
      "GET /health public=true mw=false",
      "GET /me public=false mw=false",
      "POST /items public=false mw=false",
      "DELETE /admin/items/:id public=false mw=true",
      "GET /open public=false mw=false",
    ]);
    expect(routes[1]?.body).toContain("requireAuth");
  });

  it("finds FastAPI and Flask routes with params and decorators", () => {
    const py = file(
      "app/main.py",
      [
        `from fastapi import FastAPI, Depends`,
        `app = FastAPI()`,
        `class NoteIn(BaseModel):`,
        `    title: str`,
        ``,
        `@app.post("/notes")`,
        `async def create_note(note: NoteIn, user = Depends(get_current_user)):`,
        `    return note`,
        ``,
        `@bp.route("/legacy", methods=["POST", "GET"])`,
        `@login_required`,
        `def legacy():`,
        `    return request.get_json()`,
      ].join("\n"),
    );
    const routes = findRoutes([py]);
    expect(routes.map((r) => `${r.framework} ${r.method} ${r.path}`)).toEqual(["fastapi POST /notes", "flask POST /legacy", "flask GET /legacy"]);
    expect(routes[0]?.params).toContain("note: NoteIn");
    expect(routes[1]?.body).toContain("@login_required");
  });

  it("Next.js app router paths, route groups, pages/api, middleware matcher", () => {
    const files = [
      file("src/app/(marketing)/api/posts/[id]/route.ts", `export const PATCH = withAuth(async (req) => Response.json({}));\nexport async function GET() { return Response.json([]) }`),
      file("pages/api/hello.ts", `export default function handler(req, res) { res.json({}) }`),
      file("middleware.ts", `export default auth((req) => {});\nexport const config = { matcher: ["/api/hello", "/dashboard/:path*"] };`),
    ];
    const routes = findRoutes(files);
    expect(routes.map((r) => `${r.framework} ${r.method} ${r.path} mw=${r.coveredByMiddleware}`)).toEqual([
      "next-app PATCH /api/posts/[id] mw=false",
      "next-app GET /api/posts/[id] mw=false",
      "next-pages ANY /api/hello mw=true",
    ]);
    expect(routes[0]?.body).toContain("withAuth");
    expect(routes[0]?.body).not.toContain("function GET");
  });

  it("matches forge.json publicRoutes globs", () => {
    const r = { method: "GET", path: "/api/public/feed" } as Parameters<typeof matchesPublicRoute>[0];
    expect(matchesPublicRoute(r, ["/api/public/*"])).toBe(true);
    expect(matchesPublicRoute(r, ["/api/**"])).toBe(true);
    expect(matchesPublicRoute(r, ["POST /api/public/*"])).toBe(false);
    expect(matchesPublicRoute(r, ["/api/public"])).toBe(false);
  });
});

describe("RLS analysis", () => {
  it("SQL: quoted/schema names, FORCE, policies in later migrations, skips internal schemas", () => {
    const tables = analyzeRls([
      file("supabase/migrations/1.sql", `create table public."Profiles" (id uuid, owner_id uuid);\ncreate table drizzle.__migrations (id int);\ncreate table if not exists posts (id int);\ncreate temp table scratch (x int);`),
      file("supabase/migrations/2.sql", `alter table only public."Profiles" force row level security;\ncreate policy "own" on public."Profiles" using (owner_id = auth.uid());\n-- alter table posts enable row level security;`),
    ]);
    const s = tables.map((t) => `${t.name} rls=${t.rls} policy=${t.policy} owner=${t.ownerColumn}`).sort();
    expect(s).toEqual(["posts rls=false policy=false owner=undefined", "profiles rls=true policy=true owner=owner_id"]);
  });

  it("Drizzle: enableRLS without policy, linked policies, withRLS", () => {
    const tables = analyzeRls([
      file(
        "db/schema.ts",
        [
          `export const a = pgTable("a", { id: uuid("id") }).enableRLS();`,
          `export const b = pgTable("b", { userId: uuid("user_id") });`,
          `export const bPolicy = pgPolicy("b_own", { for: "all" }).link(b);`,
          `export const c = pgTable.withRLS("c", { id: uuid("id") });`,
        ].join("\n"),
      ),
    ]);
    const s = tables.map((t) => `${t.name} rls=${t.rls} policy=${t.policy}`).sort();
    expect(s).toEqual(["a rls=true policy=false", "b rls=true policy=true", "c rls=true policy=false"]);
  });
});
