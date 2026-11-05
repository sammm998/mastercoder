import type { Finding } from "../types.js";
import { isBuildOutput, isCodeFile, isTestFile, lineOf, type SourceFile } from "../files.js";
import { matchBracket, hasDirective } from "../scanners/code.js";
import { findRoutes, matchesPublicRoute, JS_AUTH, PY_AUTH, WRITE_METHODS, type RouteHandler } from "../scanners/routes.js";
import { findSecrets } from "../scanners/secrets.js";
import { fromFindings, skipped, where, type GateContext, type GateOutcome } from "./context.js";

// ---------------------------------------------------------------- RLS

interface TableInfo {
  name: string;
  file: string;
  line: number;
  source: "sql" | "drizzle";
  ownerColumn?: string;
  rls: boolean;
  policy: boolean;
}

const IDENT = `(?:"[^"]+"|[A-Za-z_][\\w$]*)`;
const QNAME = `(${IDENT}(?:\\.${IDENT})?)`;
const SKIP_SCHEMAS = new Set(["drizzle", "supabase_migrations", "extensions", "pg_catalog", "information_schema", "graphql", "realtime", "storage", "vault", "net", "cron", "pgsodium"]);
const OWNER_COLS = ["user_id", "owner_id", "author_id", "account_id", "tenant_id", "org_id", "organization_id", "workspace_id", "team_id", "created_by", "profile_id"];

function normTable(q: string): { key: string; schema: string | null } {
  const parts = q.split(".").map((p) => p.replace(/^"|"$/g, "").toLowerCase());
  if (parts.length === 2) return { key: parts[1] ?? "", schema: parts[0] ?? null };
  return { key: parts[0] ?? "", schema: null };
}

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/--[^\n]*/g, (m) => " ".repeat(m.length));
}

export function analyzeRls(files: SourceFile[]): TableInfo[] {
  const tables = new Map<string, TableInfo>();
  const rls = new Set<string>();
  const policies = new Set<string>();
  for (const f of files) {
    if (!f.path.endsWith(".sql") || isTestFile(f.path)) continue;
    const sql = stripSqlComments(f.content);
    for (const m of sql.matchAll(new RegExp(`create\\s+(?:unlogged\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?${QNAME}\\s*\\(`, "gi"))) {
      const { key, schema } = normTable(m[1] ?? "");
      if (!key || key.startsWith("_") || (schema && SKIP_SCHEMAS.has(schema))) continue;
      const open = (m.index ?? 0) + m[0].length - 1;
      const end = matchBracket(sql, open);
      const body = sql.slice(open, end === -1 ? undefined : end).toLowerCase();
      const owner = OWNER_COLS.find((c) => new RegExp(`\\b"?${c}"?\\s+\\w`).test(body));
      if (!tables.has(key)) tables.set(key, { name: key, file: f.path, line: lineOf(sql, m.index ?? 0), source: "sql", ownerColumn: owner, rls: false, policy: false });
    }
    for (const m of sql.matchAll(new RegExp(`alter\\s+table\\s+(?:only\\s+)?(?:if\\s+exists\\s+)?${QNAME}\\s+(?:enable|force)\\s+row\\s+level\\s+security`, "gi"))) rls.add(normTable(m[1] ?? "").key);
    for (const m of sql.matchAll(new RegExp(`create\\s+policy\\s+(?:if\\s+not\\s+exists\\s+)?${IDENT}\\s+on\\s+${QNAME}`, "gi"))) policies.add(normTable(m[1] ?? "").key);
  }
  // Drizzle pgTable definitions
  const linkedPolicies = new Set<string>();
  const varToTable = new Map<string, string>();
  for (const f of files) {
    if (!/\.(ts|js|mts|mjs)$/.test(f.path) || isTestFile(f.path) || !/pgTable/.test(f.content)) continue;
    const c = f.content;
    for (const m of c.matchAll(/(?:(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*)?pgTable(?:\.withRLS)?\s*\(\s*(["'`])([\w.]+)\2/g)) {
      const key = (m[3] ?? "").toLowerCase();
      if (!key || key.startsWith("_")) continue;
      const open = c.indexOf("(", (m.index ?? 0) + m[0].indexOf("pgTable"));
      const end = matchBracket(c, open);
      const call = c.slice(open, end === -1 ? undefined : end);
      const after = end === -1 ? "" : c.slice(end, end + 40);
      const owner = /\b(userId|ownerId|authorId|accountId|tenantId|orgId|organizationId|workspaceId|teamId|createdBy)\s*:/.exec(call)?.[1];
      const ownerSnake = owner ? owner.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`) : undefined;
      const withRls = /pgTable\.withRLS/.test(m[0]) || /^\s*\.enableRLS\(\)/.test(after);
      const hasPolicy = /\bpgPolicy\s*\(/.test(call);
      if (m[1]) varToTable.set(m[1], key);
      const existing = tables.get(key);
      if (existing) {
        existing.rls ||= withRls || hasPolicy;
        existing.policy ||= hasPolicy;
      } else {
        tables.set(key, { name: key, file: f.path, line: lineOf(c, m.index ?? 0), source: "drizzle", ownerColumn: ownerSnake, rls: withRls || hasPolicy, policy: hasPolicy });
      }
    }
    for (const m of c.matchAll(/pgPolicy\s*\([\s\S]*?\)\s*\.link\(\s*(\w+)\s*\)/g)) linkedPolicies.add(m[1] ?? "");
  }
  for (const v of linkedPolicies) {
    const key = varToTable.get(v);
    if (key) policies.add(key);
  }
  for (const t of tables.values()) {
    if (rls.has(t.name)) t.rls = true;
    if (policies.has(t.name)) {
      t.policy = true;
      if (t.source === "drizzle") t.rls = true; // drizzle enables RLS for tables with linked policies
    }
  }
  return [...tables.values()];
}

function rlsFixFor(t: TableInfo, supabase: boolean): string {
  const owner = t.ownerColumn ?? "user_id";
  const who = supabase ? "auth.uid()" : "current_setting('app.user_id', true)::uuid";
  const lines: string[] = [];
  if (!t.rls) lines.push(`ALTER TABLE ${t.name} ENABLE ROW LEVEL SECURITY;`);
  if (!t.policy) {
    lines.push(`CREATE POLICY ${t.name}_owner_all ON ${t.name} FOR ALL USING (${owner} = ${who}) WITH CHECK (${owner} = ${who});`);
  }
  if (t.source === "drizzle") {
    lines.push(`-- or in Drizzle: pgTable("${t.name}", {...}, (t) => [pgPolicy("${t.name}_owner_all", { for: "all", using: sql\`${owner} = ${who}\`, withCheck: sql\`${owner} = ${who}\` })])`);
  }
  if (!t.ownerColumn) lines.push(`-- ${t.name} has no owner column: add one (e.g. ${owner} uuid not null references users(id)) or write a policy that matches your access model.`);
  return lines.join("\n");
}

export async function rlsGate(ctx: GateContext): Promise<GateOutcome> {
  const files = await ctx.files();
  const tables = analyzeRls(files);
  if (tables.length === 0) return skipped("skipped: no CREATE TABLE in SQL migrations and no Drizzle pgTable definitions");
  const supabase = ctx.project.deps.has("@supabase/supabase-js") || files.some((f) => f.path.startsWith("supabase/"));
  const findings: Finding[] = [];
  const bad = tables.filter((t) => !t.rls || !t.policy);
  for (const t of bad) {
    const missing = [!t.rls ? "ENABLE ROW LEVEL SECURITY" : null, !t.policy ? "a CREATE POLICY" : null].filter(Boolean).join(" and ");
    findings.push({ file: t.file, line: t.line, rule: !t.rls ? "rls/not-enabled" : "rls/no-policy", message: `table "${t.name}" is missing ${missing}`, severity: "error" });
  }
  return fromFindings(
    findings,
    `${tables.length} table(s) all have RLS enabled and >=1 policy`,
    (n) => `${n} of ${tables.length} table(s) missing row level security`,
    () => `Add a migration enabling RLS with an owner policy for each table:\n${bad.map((t) => rlsFixFor(t, supabase)).join("\n")}`,
  );
}

// ---------------------------------------------------------------- auth

function hasAuthCheck(r: RouteHandler): boolean {
  if (r.coveredByMiddleware) return true;
  if (r.framework === "fastapi" || r.framework === "flask") return PY_AUTH.test(r.body) || PY_AUTH.test(r.params ?? "");
  return JS_AUTH.test(r.body);
}

function describe(r: RouteHandler): string {
  return r.method === "ACTION" ? `server action ${r.path.split("#")[1]}` : `${r.method} ${r.path}`;
}

function authFix(r: RouteHandler): string {
  switch (r.framework) {
    case "fastapi":
      return `${r.file}:${r.line} add a dependency: \`user: User = Depends(get_current_user)\` (raise HTTPException(401) when missing)`;
    case "flask":
      return `${r.file}:${r.line} decorate with @login_required`;
    case "express":
    case "fastify":
    case "hono":
      return `${r.file}:${r.line} add auth middleware: \`${r.framework === "hono" ? "app" : "router"}.${r.method.toLowerCase()}("${r.path}", requireAuth, handler)\``;
    default:
      return `${r.file}:${r.line} start ${describe(r)} with \`const session = await auth(); if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401 });\``;
  }
}

export async function authGate(ctx: GateContext): Promise<GateOutcome> {
  const routes = findRoutes(await ctx.files());
  if (routes.length === 0) return skipped("skipped: no route handlers or server actions found");
  const unauth = routes.filter((r) => !r.publicMarker && !matchesPublicRoute(r, ctx.project.publicRoutes) && !hasAuthCheck(r));
  const findings: Finding[] = unauth.map((r) => ({
    file: r.file,
    line: r.line,
    rule: "auth/missing-check",
    message: `${describe(r)} has no authentication check and is not marked public`,
    severity: "error",
  }));
  const pub = routes.filter((r) => r.publicMarker || matchesPublicRoute(r, ctx.project.publicRoutes)).length;
  return fromFindings(
    findings,
    `${routes.length} handler(s): all authenticated or public (${pub} public)`,
    (n) => `${n} of ${routes.length} handler(s) lack an auth check`,
    () =>
      `Require authentication in each handler (or mark intentionally public endpoints with \`// forge:public\` or forge.json "publicRoutes"):\n` +
      unauth.map((r) => `- ${authFix(r)}`).join("\n"),
  );
}

// ---------------------------------------------------------------- validation

const JS_INPUT = /\b(req|request|c\.req|ctx\.request)\.(json|formData|text|body|parseBody)\b|\bawait\s+\w+\.(json|formData)\(\)|\breq\.body\b|\brequest\.body\b/;
const JS_VALIDATION =
  /(?<!JSON)\.(parse|safeParse|parseAsync|safeParseAsync)\s*\(|\bv\.(parse|safeParse)\s*\(|\b(safeParse|parse)\s*\(\s*\w*Schema\b|\.(validate|validateSync|validateAsync|isValid)\s*\(|\b(zValidator|vValidator|tbValidator|typiaValidator)\s*\(|typia\.(assert|validate)|\bassert\s*\(\s*\w+\s*,\s*\w*(Schema|Struct)\b|\bschema\s*:\s*\{[^}]*\bbody\b|\bvalidate\w*\s*\(/;
const PY_INPUT = /await\s+request\.(json|body|form)\(\)|request\.(get_json|json|form|data|values)\b/;
const PY_VALIDATION = /\.(model_validate|model_validate_json|parse_obj|parse_raw)\s*\(|\w+Schema\(\)\.load\(|\bvalidate\(|\w+\(\*\*\w+\)/;

function pydanticModels(files: SourceFile[]): Set<string> {
  const out = new Set<string>();
  for (const f of files) if (f.path.endsWith(".py")) for (const m of f.content.matchAll(/class\s+(\w+)\s*\(\s*[\w.]*(BaseModel|SQLModel|Schema)\b/g)) out.add(m[1] ?? "");
  return out;
}

export async function validationGate(ctx: GateContext): Promise<GateOutcome> {
  const files = await ctx.files();
  const routes = findRoutes(files);
  const models = pydanticModels(files);
  const writes = routes.filter((r) => WRITE_METHODS.has(r.method) || r.method === "ACTION" || (r.method === "ANY" && /\bPOST|PUT|PATCH\b|req\.body/.test(r.body)));
  if (writes.length === 0) return skipped("skipped: no POST/PUT/PATCH handlers or server actions found");
  const bad: RouteHandler[] = [];
  for (const r of writes) {
    if (r.framework === "fastapi" || r.framework === "flask") {
      const modelParam = [...(r.params ?? "").matchAll(/:\s*(?:Annotated\[\s*)?(\w+)/g)].some((m) => models.has(m[1] ?? ""));
      if (modelParam) continue;
      if (PY_INPUT.test(r.body) && !PY_VALIDATION.test(r.body)) bad.push(r);
      continue;
    }
    const readsInput = JS_INPUT.test(r.body) || (r.method === "ACTION" && /\(\s*[^)\s]/.test(r.body.slice(r.body.indexOf("("), r.body.indexOf(")") + 1)));
    if (readsInput && !JS_VALIDATION.test(r.body)) bad.push(r);
  }
  const findings: Finding[] = bad.map((r) => ({
    file: r.file,
    line: r.line,
    rule: "validation/unvalidated-input",
    message: `${describe(r)} uses request input without schema validation (zod/valibot/yup/pydantic)`,
    severity: "error",
  }));
  const fixFor = (r: RouteHandler): string =>
    r.framework === "fastapi" || r.framework === "flask"
      ? `- ${r.file}:${r.line} declare a Pydantic model (class ${r.method === "PUT" ? "Update" : "Create"}Item(BaseModel): ...) and take it as the body parameter instead of reading request.json()`
      : `- ${r.file}:${r.line} validate before use: \`const input = Schema.safeParse(await req.json()); if (!input.success) return Response.json(input.error.flatten(), { status: 400 });\` with \`const Schema = z.object({ ... })\``;
  return fromFindings(
    findings,
    `${writes.length} write handler(s): all validate their input`,
    (n) => `${n} of ${writes.length} write handler(s) accept unvalidated input`,
    () => `Validate every POST/PUT/PATCH body and server-action argument with a schema:\n${bad.map(fixFor).join("\n")}`,
  );
}

// ---------------------------------------------------------------- client secrets

const PUBLIC_ENV = /^(NEXT_PUBLIC_|VITE_|EXPO_PUBLIC_|PUBLIC_|REACT_APP_|NUXT_PUBLIC_|GATSBY_)/;
const SAFE_ENV = new Set(["NODE_ENV", "MODE", "DEV", "PROD", "SSR", "BASE_URL", "TZ"]);
const SECRETISH = /(SECRET|PRIVATE|PASSWORD|SERVICE_ROLE|_TOKEN$|API_KEY$|ACCESS_KEY|SIGNING)/;

interface ClientFile {
  file: SourceFile;
  bundle: boolean;
}

function clientFiles(ctx: GateContext, files: SourceFile[]): ClientFile[] {
  const kind = ctx.project.kind;
  const vite = kind === "vite" || files.some((f) => /^vite\.config\./.test(f.path));
  const expo = kind === "expo" || ctx.project.deps.has("expo");
  const out: ClientFile[] = [];
  for (const f of files) {
    if (isTestFile(f.path)) continue;
    if (/^(dist|build|out)\/.*\.(js|mjs)$|^\.next\/static\/.*\.js$|^out\/_next\/static\/.*\.js$/.test(f.path)) {
      out.push({ file: f, bundle: true });
      continue;
    }
    if (!isCodeFile(f.path) || isBuildOutput(f.path) || f.path.endsWith(".py")) continue;
    const serverish = /(^|\/)(server|api)\/|\.server\.[jt]sx?$|\+api\.[jt]sx?$|(^|\/)middleware\.[jt]s$|(^|\/)route\.[jt]sx?$|vite\.config\./.test(f.path);
    if (hasDirective(f.content, "use client")) out.push({ file: f, bundle: false });
    else if (vite && /^src\//.test(f.path) && !serverish) out.push({ file: f, bundle: false });
    else if (expo && /^(app|components|src|hooks)\//.test(f.path) && !serverish) out.push({ file: f, bundle: false });
  }
  return out;
}

export async function clientSecretsGate(ctx: GateContext): Promise<GateOutcome> {
  const files = await ctx.files();
  const client = clientFiles(ctx, files);
  if (client.length === 0) return skipped('skipped: no client code found ("use client" files, Vite src/, Expo app/, or built bundles)');
  const findings: Finding[] = [];
  for (const m of findSecrets(client.map((c) => c.file))) {
    findings.push({ file: m.file, line: m.line, rule: `client-secrets/${m.rule.id}`, message: `${m.rule.description} shipped to the browser/app bundle`, severity: "error" });
  }
  for (const { file, bundle } of client) {
    if (bundle) continue;
    file.lines.forEach((l, i) => {
      if (/^\s*(\/\/|\*)/.test(l)) return;
      for (const m of l.matchAll(/\bprocess\.env(?:\.([A-Z_][A-Z0-9_]*)|\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\])/g)) {
        const name = m[1] ?? m[2] ?? "";
        if (SAFE_ENV.has(name)) continue;
        if (!PUBLIC_ENV.test(name)) findings.push({ file: file.path, line: i + 1, rule: "client-secrets/server-env-in-client", message: `server-only env var process.env.${name} referenced in client code`, severity: "error" });
        else if (SECRETISH.test(name.replace(PUBLIC_ENV, ""))) findings.push({ file: file.path, line: i + 1, rule: "client-secrets/secret-with-public-prefix", message: `${name} looks like a secret but uses a public prefix (it is inlined into the bundle)`, severity: "error" });
      }
      for (const m of l.matchAll(/\bimport\.meta\.env\.([A-Z_][A-Z0-9_]*)/g)) {
        const name = m[1] ?? "";
        if (SAFE_ENV.has(name)) continue;
        if (!PUBLIC_ENV.test(name)) findings.push({ file: file.path, line: i + 1, rule: "client-secrets/server-env-in-client", message: `import.meta.env.${name} is not VITE_-prefixed (server-only) but used in client code`, severity: "error" });
        else if (SECRETISH.test(name.replace(PUBLIC_ENV, ""))) findings.push({ file: file.path, line: i + 1, rule: "client-secrets/secret-with-public-prefix", message: `${name} looks like a secret but is exposed to the client`, severity: "error" });
      }
    });
  }
  return fromFindings(
    findings,
    `${client.length} client file(s)/bundle(s): no secrets or server-only env vars`,
    (n) => `${n} secret exposure(s) in client code`,
    () =>
      "Move secret use to server code (a route handler / server action / API) and call it from the client; never reference " +
      "server-only env vars or secret values in \"use client\" files or bundles. Rotate any key that reached a bundle.\n" +
      findings.filter((f) => f.severity === "error").slice(0, 15).map((f) => `- ${where(f)} ${f.message}`).join("\n"),
  );
}
