import { isBuildOutput, isTestFile, lineOf, type SourceFile } from "../files.js";
import { extractJsBlock, extractPyBlock, hasDirective, matchBracket } from "./code.js";

export type Framework = "next-app" | "next-pages" | "next-action" | "express" | "hono" | "fastify" | "fastapi" | "flask";

export interface RouteHandler {
  file: string;
  line: number;
  /** HTTP method, "ANY" (pages/api) or "ACTION" (server action). */
  method: string;
  path: string;
  framework: Framework;
  /** Handler source (plus inline middleware/decorators). */
  body: string;
  /** Python only: parameter list text. */
  params?: string;
  /** Marked `forge:public` (file header, comment above, or in the handler). */
  publicMarker: boolean;
  /** Covered by file-level / router-level / Next middleware auth. */
  coveredByMiddleware: boolean;
}

const PUBLIC_MARK = /forge:public\b/;
const HTTP = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export const JS_AUTH =
  /\b(auth|getServerSession|getSession|getServerAuthSession|requireAuth|requireUser|requireSession|requireLogin|currentUser|getCurrentUser|getUser|getUserOrThrow|verifyToken|verifySession|validateRequest|validateSession|withAuth|isAuthenticated|ensureAuthenticated|ensureLoggedIn|authenticate|authorize|getAuth|protect|checkAuth|jwtVerify|clerkMiddleware|authMiddleware)\s*\(|jwt\.verify\(|passport\.authenticate\(|\b(req|request|ctx\.state|ctx|locals|event\.locals)\.(user|session|auth)\b|c\.get\(\s*['"](user|session|jwtPayload)['"]\s*\)|\.auth\.getUser\(|\bsession\?*\.user\b/;
const JS_AUTH_MW = /\b(auth\w*|authenticate\w*|requireAuth\w*|requireUser|requireSession|protect\w*|jwt|bearerAuth|basicAuth|session\w*|ensureLoggedIn|isLoggedIn|verify\w*|clerkMiddleware|withAuth)\b/i;
export const PY_AUTH =
  /Depends\(\s*[\w.]*(auth|user|current|token|verify|session|login|principal|permission)\w*|Security\(|@\w*(login_required|jwt_required|requires_auth|auth_required|permission_required|authenticated)\b|request\.user\.is_authenticated|current_user\b|get_jwt_identity\(|verify_(token|jwt)\(/i;

function nextAppPath(file: string): string | null {
  const m = /(?:^|\/)app\/(.*?)\/?route\.(?:ts|tsx|js|jsx|mjs)$/.exec(file);
  if (!m) return null;
  const segs = (m[1] ?? "").split("/").filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("@"));
  return "/" + segs.join("/");
}

function pagesApiPath(file: string): string | null {
  const m = /(?:^|\/)pages\/(api\/.*)\.(?:ts|tsx|js|jsx|mjs)$/.exec(file);
  if (!m) return null;
  return "/" + (m[1] ?? "").replace(/\/index$/, "");
}

function isPublic(f: SourceFile, line: number, body: string): boolean {
  if (f.lines.slice(0, 10).some((l) => PUBLIC_MARK.test(l) && /^\s*(\/\/|#|\/?\*)/.test(l))) return true;
  // same line, or the comment/decorator lines directly above the handler
  if (PUBLIC_MARK.test(f.lines[line - 1] ?? "")) return true;
  for (let i = line - 2; i >= 0 && i >= line - 7; i--) {
    const l = f.lines[i] ?? "";
    if (!/^\s*(\/\/|#|@|\*|\/\*)/.test(l)) break;
    if (PUBLIC_MARK.test(l)) return true;
  }
  return PUBLIC_MARK.test(body);
}

interface Middleware {
  covers: (path: string) => boolean;
}

/** Next.js middleware.ts with an auth check: matcher → coverage predicate. */
function nextMiddleware(files: SourceFile[]): Middleware | null {
  const mw = files.find((f) => /^(src\/)?middleware\.(ts|js)$/.test(f.path));
  if (!mw || !JS_AUTH.test(mw.content) && !/clerkMiddleware|withAuth|NextAuth|auth\(/.test(mw.content)) return null;
  const matcherBlock = /matcher\s*:\s*(\[[\s\S]*?\]|['"`][^'"`]+['"`])/.exec(mw.content)?.[1];
  if (!matcherBlock) return { covers: () => true };
  const patterns = [...matcherBlock.matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1] ?? "");
  const regexes = patterns.map((p) => {
    const src = p
      .replace(/[.+^$|]/g, "\\$&")
      .replace(/\/:[\w]+\*/g, "(?:/.*)?")
      .replace(/\/:[\w]+\+/g, "/.+")
      .replace(/:[\w]+/g, "[^/]+");
    try {
      return new RegExp(`^${src}$`);
    } catch {
      return /^$/;
    }
  });
  return { covers: (path) => regexes.some((r) => r.test(path)) };
}

function jsRoutes(f: SourceFile, out: RouteHandler[], nextMw: Middleware | null): void {
  const c = f.content;
  const appPath = nextAppPath(f.path);
  if (appPath !== null) {
    for (const m of c.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|export\s+const\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*=/g)) {
      const method = m[1] ?? m[2] ?? "GET";
      const body = extractJsBlock(c, m.index ?? 0);
      const line = lineOf(c, m.index ?? 0);
      out.push({ file: f.path, line, method, path: appPath, framework: "next-app", body, publicMarker: isPublic(f, line, body), coveredByMiddleware: nextMw?.covers(appPath) ?? false });
    }
    return;
  }
  const pagesPath = pagesApiPath(f.path);
  if (pagesPath !== null) {
    const m = /export\s+default\s+/.exec(c);
    const line = m ? lineOf(c, m.index) : 1;
    out.push({ file: f.path, line, method: "ANY", path: pagesPath, framework: "next-pages", body: c, publicMarker: isPublic(f, line, ""), coveredByMiddleware: nextMw?.covers(pagesPath) ?? false });
    return;
  }
  // Server actions: file-level "use server" exports, or inline "use server" functions.
  if (hasDirective(c, "use server")) {
    for (const m of c.matchAll(/export\s+(?:async\s+function\s+(\w+)|const\s+(\w+)\s*=\s*async\b)/g)) {
      const name = m[1] ?? m[2] ?? "action";
      const body = extractJsBlock(c, m.index ?? 0);
      const line = lineOf(c, m.index ?? 0);
      out.push({ file: f.path, line, method: "ACTION", path: `action:${f.path}#${name}`, framework: "next-action", body, publicMarker: isPublic(f, line, body), coveredByMiddleware: false });
    }
  } else {
    for (const m of c.matchAll(/async\s+function\s+(\w+)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*['"]use server['"]/g)) {
      const body = extractJsBlock(c, m.index ?? 0);
      const line = lineOf(c, m.index ?? 0);
      out.push({ file: f.path, line, method: "ACTION", path: `action:${f.path}#${m[1]}`, framework: "next-action", body, publicMarker: isPublic(f, line, body), coveredByMiddleware: false });
    }
  }
  // Express / Fastify / Hono style
  const framework: Framework = /from\s+['"]hono['"]|require\(['"]hono['"]\)/.test(c) ? "hono" : /fastify/.test(c) ? "fastify" : "express";
  const uses: Array<{ index: number; prefix: string | null }> = [];
  for (const u of c.matchAll(/\b\w+\.(use|addHook)\s*\(/g)) {
    const open = (u.index ?? 0) + u[0].length - 1;
    const end = matchBracket(c, open);
    const call = c.slice(open, end === -1 ? undefined : end);
    if (u[1] === "addHook" ? /onRequest|preHandler|preValidation/.test(call) && JS_AUTH_MW.test(call) : JS_AUTH_MW.test(call.replace(/^\(\s*['"`][^'"`]*['"`]\s*,?/, ""))) {
      const prefix = /^\(\s*['"`]([^'"`]+)['"`]/.exec(call)?.[1] ?? null;
      uses.push({ index: u.index ?? 0, prefix });
    }
  }
  for (const m of c.matchAll(/\b(\w+)\.(get|post|put|patch|delete|all)\s*\(\s*(['"`])([^'"`]+)\3/g)) {
    const obj = m[1] ?? "";
    if (/^(axios|http|https|fetch|client|api\w*Client|supabase|redis|cache|map|params|searchParams|headers|cookies|formData|db|prisma|knex)$/i.test(obj)) continue;
    const path = m[4] ?? "";
    if (!path.startsWith("/")) continue;
    const open = (m.index ?? 0) + m[0].indexOf("(");
    const end = matchBracket(c, open);
    const body = c.slice(m.index ?? 0, end === -1 ? undefined : end);
    const line = lineOf(c, m.index ?? 0);
    const covered = uses.some((u) => u.index < (m.index ?? 0) && (u.prefix === null || path.startsWith(u.prefix.replace(/\*.*$/, "").replace(/\/$/, ""))));
    out.push({ file: f.path, line, method: (m[2] ?? "get").toUpperCase(), path, framework, body, publicMarker: isPublic(f, line, body), coveredByMiddleware: covered });
  }
}

function pyRoutes(f: SourceFile, out: RouteHandler[]): void {
  const c = f.content;
  const routerDeps = new Set<string>();
  for (const m of c.matchAll(/(\w+)\s*=\s*(?:APIRouter|FastAPI)\(([^)]*(?:\([^)]*\)[^)]*)*)\)/g)) if (PY_AUTH.test(m[2] ?? "")) routerDeps.add(m[1] ?? "");
  f.lines.forEach((l, i) => {
    const fa = /^\s*@(\w+)\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']([^\n]*)/.exec(l);
    const fl = /^\s*@(\w+)\.route\(\s*["']([^"']+)["']([^\n]*)/.exec(l);
    if (!fa && !fl) return;
    let d = i + 1;
    const decorators = [l];
    while (d < f.lines.length && !/^\s*(async\s+)?def\s/.test(f.lines[d] ?? "")) {
      decorators.push(f.lines[d] ?? "");
      d++;
    }
    if (d >= f.lines.length) return;
    const { text, params } = extractPyBlock(f.lines, d);
    const body = decorators.join("\n") + "\n" + text;
    if (fa) {
      out.push({ file: f.path, line: i + 1, method: (fa[2] ?? "get").toUpperCase(), path: fa[3] ?? "/", framework: "fastapi", body, params, publicMarker: isPublic(f, i + 1, body), coveredByMiddleware: routerDeps.has(fa[1] ?? "") });
    } else if (fl) {
      const methods = /methods\s*=\s*\[([^\]]*)\]/.exec(fl[3] ?? "")?.[1];
      const list = methods ? [...methods.matchAll(/["'](\w+)["']/g)].map((x) => (x[1] ?? "GET").toUpperCase()) : ["GET"];
      for (const method of list) out.push({ file: f.path, line: i + 1, method, path: fl[2] ?? "/", framework: "flask", body, params, publicMarker: isPublic(f, i + 1, body), coveredByMiddleware: false });
    }
  });
}

/** All HTTP route handlers and server actions in the project. */
export function findRoutes(files: SourceFile[]): RouteHandler[] {
  const out: RouteHandler[] = [];
  const nextMw = nextMiddleware(files);
  for (const f of files) {
    if (isTestFile(f.path) || isBuildOutput(f.path) || /(^|\/)node_modules\//.test(f.path)) continue;
    if (/\.(ts|tsx|js|jsx|mjs|cjs|mts)$/.test(f.path)) jsRoutes(f, out, nextMw);
    else if (f.path.endsWith(".py")) pyRoutes(f, out);
  }
  return out;
}

/** forge.json publicRoutes match: "/api/health", "/api/public/*", "/blog/**", optionally "GET /path". */
export function matchesPublicRoute(route: RouteHandler, patterns: string[]): boolean {
  for (const raw of patterns) {
    const pm = /^([A-Z]+)\s+(\S+)$/.exec(raw.trim());
    const method = pm ? pm[1] : null;
    const pattern = pm ? (pm[2] ?? "") : raw.trim();
    if (method && method !== route.method) continue;
    const src = pattern
      .replace(/[.+^$|()]/g, "\\$&")
      .split("**")
      .map((part) => part.replace(/\*/g, "[^/]*"))
      .join(".*");
    if (new RegExp(`^${src}/?$`).test(route.path)) return true;
  }
  return false;
}

export const WRITE_METHODS = new Set(["POST", "PUT", "PATCH"]);
export { HTTP };
