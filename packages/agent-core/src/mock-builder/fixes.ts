import type { Spec } from "../spec.js";

/**
 * Deterministic repairs for quality-gate failures. Only fixes whose correct form follows from the
 * finding itself are applied; everything else is reported as "needs a model" so the loop guard can
 * stop without charging the user.
 */

export interface GateFailure {
  gate: string;
  findings: Array<{ file?: string; line?: number; rule: string; message: string }>;
  fix?: string;
}

export function parseGateFailures(text: string): GateFailure[] {
  const out: GateFailure[] = [];
  const parts = text.split(/^### (\S+) FAILED$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const gate = parts[i] ?? "";
    const body = parts[i + 1] ?? "";
    const findings: GateFailure["findings"] = [];
    for (const m of body.matchAll(/^\s+- (?:(\S+?)(?::(\d+))? )?\[([^\]]+)\] (.*)$/gm)) {
      findings.push({ file: m[1], line: m[2] ? Number(m[2]) : undefined, rule: m[3] ?? gate, message: m[4] ?? "" });
    }
    const fix = /\nProposed fix: ([\s\S]*)$/.exec(body)?.[1]?.trim();
    out.push({ gate, findings, fix });
  }
  return out;
}

/** Routes that are public by nature (liveness, API docs) and expose no user data. */
const INFRA_PUBLIC = /^\/(api\/)?(health|healthz|ready|readyz|livez|openapi\.json|docs|redoc)$/;

export type AuthPlan =
  | { kind: "public"; file: string; line: number; reason: string }
  | { kind: "session"; file: string; line: number; framework: "next-app" | "next-action" }
  | { kind: "none"; file?: string; reason: string };

export function planAuthFix(f: GateFailure["findings"][number], spec: Spec | undefined, files: Set<string>): AuthPlan {
  if (!f.file || !f.line) return { kind: "none", reason: "the finding has no file/line" };
  const route = /^(?:(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY) (\S+)|server action (\S+))/.exec(f.message);
  const path = route?.[2];
  if (path && INFRA_PUBLIC.test(path)) return { kind: "public", file: f.file, line: f.line, reason: `${path} is an infrastructure endpoint without user data` };
  if (spec && !spec.auth) return { kind: "public", file: f.file, line: f.line, reason: "the spec has no user accounts (spec.auth = false)" };
  const isNextRoute = /(^|\/)app\/.*route\.(ts|tsx|js)$/.test(f.file);
  const hasSession = files.has("src/lib/session.ts");
  if (hasSession && isNextRoute) return { kind: "session", file: f.file, line: f.line, framework: "next-app" };
  if (hasSession && route?.[3]) return { kind: "session", file: f.file, line: f.line, framework: "next-action" };
  return { kind: "none", file: f.file, reason: "the app requires sign-in and no deterministic auth check fits this handler" };
}

function commentFor(file: string): string {
  return file.endsWith(".py") ? "#" : "//";
}

/** Insert a `forge:public` marker directly above the handler (and above its decorators/comments). */
export function addPublicMarker(content: string, file: string, line: number, reason: string): string {
  const lines = content.split("\n");
  if (lines.slice(Math.max(0, line - 7), line).some((l) => /forge:public\b/.test(l))) return content;
  lines.splice(Math.max(0, line - 1), 0, `${" ".repeat(/^\s*/.exec(lines[line - 1] ?? "")?.[0].length ?? 0)}${commentFor(file)} forge:public — ${reason}`);
  return lines.join("\n");
}

function addImport(content: string, line: string): string {
  if (content.includes(line)) return content;
  const lines = content.split("\n");
  let at = 0;
  while (at < lines.length && /^\s*(["']use (client|server)["'];?|\/\/.*|\/\*.*|\*.*)?\s*$/.test(lines[at] ?? "")) at++;
  while (at < lines.length && /^import\s/.test(lines[at] ?? "")) at++;
  lines.splice(at, 0, line);
  return lines.join("\n");
}

/** Add a session check at the start of a Next.js route handler or server action. */
export function addSessionCheck(content: string, line: number, framework: "next-app" | "next-action"): string | null {
  const lines = content.split("\n");
  let i = line - 1;
  while (i < lines.length && !/\{\s*$/.test(lines[i] ?? "")) i++;
  if (i >= lines.length) return null;
  const sig = lines[line - 1] ?? "";
  if (!/\basync\b/.test(sig)) lines[line - 1] = sig.replace(/\bfunction\b/, "async function");
  const indent = /^\s+/.exec(lines[i + 1] ?? "")?.[0] ?? "  ";
  if (framework === "next-app") {
    lines.splice(i + 1, 0, `${indent}const session = await getSession();`, `${indent}if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });`);
    return addImport(lines.join("\n"), `import { getSession } from "@/lib/session";`);
  }
  lines.splice(i + 1, 0, `${indent}await requireUser();`);
  return addImport(lines.join("\n"), `import { requireUser } from "@/lib/session";`);
}

/** SQL statements from the RLS gate's proposed fix, adapted to the app-kit helper when present. */
export function rlsSqlFromFix(fix: string | undefined, hasForgeHelper: boolean): string[] {
  if (!fix) return [];
  const stmts = fix
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^ALTER TABLE \S+ ENABLE ROW LEVEL SECURITY;$/i.test(l) || /^CREATE POLICY \S+ ON \S+ .*;$/i.test(l));
  if (!hasForgeHelper) return stmts;
  return stmts.map((s) => s.replace(/(\w+) = current_setting\('app\.user_id', true\)::uuid/g, "$1::text = forge_current_user_id()"));
}

export function shortHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
