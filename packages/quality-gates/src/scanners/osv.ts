import { z } from "zod";
import type { Finding } from "../types.js";
import type { SourceFile } from "../files.js";

export interface Dependency {
  name: string;
  version: string;
  ecosystem: "npm" | "PyPI";
  file: string;
  line?: number;
  /** True when taken from a version range in a manifest (no lockfile). */
  approximate?: boolean;
}

const lineFinder = (f: SourceFile) => (needle: string): number | undefined => {
  const i = f.lines.findIndex((l) => l.includes(needle));
  return i >= 0 ? i + 1 : undefined;
};

function parsePackageLock(f: SourceFile): Dependency[] {
  let doc: unknown;
  try {
    doc = JSON.parse(f.content);
  } catch {
    return [];
  }
  const parsed = z
    .object({
      packages: z.record(z.object({ version: z.string().optional() }).passthrough()).optional(),
      dependencies: z.record(z.object({ version: z.string().optional() }).passthrough()).optional(),
    })
    .passthrough()
    .safeParse(doc);
  if (!parsed.success) return [];
  const find = lineFinder(f);
  const out: Dependency[] = [];
  if (parsed.data.packages) {
    for (const [key, v] of Object.entries(parsed.data.packages)) {
      if (!key || !v.version) continue;
      const name = key.replace(/^.*node_modules\//, "");
      out.push({ name, version: v.version, ecosystem: "npm", file: f.path, line: find(`"${key}"`) });
    }
  } else if (parsed.data.dependencies) {
    for (const [name, v] of Object.entries(parsed.data.dependencies)) {
      if (v.version) out.push({ name, version: v.version, ecosystem: "npm", file: f.path, line: find(`"${name}"`) });
    }
  }
  return out;
}

function parsePnpmLock(f: SourceFile): Dependency[] {
  const out: Dependency[] = [];
  let inPackages = false;
  f.lines.forEach((l, i) => {
    if (/^packages:\s*$/.test(l)) inPackages = true;
    else if (/^\S/.test(l)) inPackages = false;
    if (!inPackages) return;
    const m = /^ {2}['"]?\/?((?:@[^/@\s'"]+\/)?[^@\s'"/]+)@([0-9][^(:'"\s]*)/.exec(l);
    if (m && m[1] && m[2]) out.push({ name: m[1], version: m[2], ecosystem: "npm", file: f.path, line: i + 1 });
  });
  return out;
}

function parseYarnLock(f: SourceFile): Dependency[] {
  const out: Dependency[] = [];
  let current: { name: string; line: number } | null = null;
  f.lines.forEach((l, i) => {
    const head = /^"?((?:@[^/@"]+\/)?[^@"\s]+)@[^:]*:\s*$/.exec(l);
    if (head && head[1]) {
      current = { name: head[1], line: i + 1 };
      return;
    }
    const ver = /^\s+version:?\s+"?([^"\s]+)"?/.exec(l);
    if (ver && ver[1] && current) {
      out.push({ name: current.name, version: ver[1], ecosystem: "npm", file: f.path, line: current.line });
      current = null;
    }
  });
  return out;
}

function parseRequirements(f: SourceFile): Dependency[] {
  const out: Dependency[] = [];
  f.lines.forEach((l, i) => {
    const m = /^\s*([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*==\s*([0-9][^\s;#]*)/.exec(l);
    if (m && m[1] && m[2]) out.push({ name: m[1], version: m[2], ecosystem: "PyPI", file: f.path, line: i + 1 });
  });
  return out;
}

function parseTomlLock(f: SourceFile): Dependency[] {
  const out: Dependency[] = [];
  let name: string | null = null;
  let nameLine = 0;
  f.lines.forEach((l, i) => {
    if (/^\[\[package\]\]/.test(l)) name = null;
    const n = /^name\s*=\s*"([^"]+)"/.exec(l);
    if (n && n[1]) {
      name = n[1];
      nameLine = i + 1;
    }
    const v = /^version\s*=\s*"([^"]+)"/.exec(l);
    if (v && v[1] && name) {
      out.push({ name, version: v[1], ecosystem: "PyPI", file: f.path, line: nameLine });
      name = null;
    }
  });
  return out;
}

function parsePackageJson(f: SourceFile): Dependency[] {
  let doc: unknown;
  try {
    doc = JSON.parse(f.content);
  } catch {
    return [];
  }
  const parsed = z.object({ dependencies: z.record(z.string()).optional(), devDependencies: z.record(z.string()).optional() }).passthrough().safeParse(doc);
  if (!parsed.success) return [];
  const find = lineFinder(f);
  const out: Dependency[] = [];
  for (const [name, range] of Object.entries({ ...parsed.data.dependencies, ...parsed.data.devDependencies })) {
    const m = /^[\^~>=v\s]*(\d+\.\d+\.\d+[^\s|]*)/.exec(range);
    if (m && m[1]) out.push({ name, version: m[1], ecosystem: "npm", file: f.path, line: find(`"${name}"`), approximate: !/^\d/.test(range) });
  }
  return out;
}

/** Collect resolved dependencies from lockfiles (package.json ranges only when a directory has no lockfile). */
export function collectDependencies(files: SourceFile[]): Dependency[] {
  const deps: Dependency[] = [];
  const lockDirs = new Set<string>();
  const dir = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  for (const f of files) {
    const base = f.path.split("/").pop() ?? "";
    if (/(^|\/)node_modules\//.test(f.path)) continue;
    let found: Dependency[] = [];
    if (base === "package-lock.json" || base === "npm-shrinkwrap.json") found = parsePackageLock(f);
    else if (base === "pnpm-lock.yaml") found = parsePnpmLock(f);
    else if (base === "yarn.lock") found = parseYarnLock(f);
    else if (/^requirements.*\.txt$/.test(base)) found = parseRequirements(f);
    else if (base === "poetry.lock" || base === "uv.lock") found = parseTomlLock(f);
    else continue;
    if (["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"].includes(base)) lockDirs.add(dir(f.path));
    deps.push(...found);
  }
  for (const f of files) {
    if (f.path.endsWith("package.json") && !/node_modules\//.test(f.path) && !lockDirs.has(dir(f.path))) deps.push(...parsePackageJson(f));
  }
  const seen = new Set<string>();
  return deps.filter((d) => {
    const k = `${d.ecosystem}:${d.name}@${d.version}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const BatchResponse = z.object({
  results: z.array(z.object({ vulns: z.array(z.object({ id: z.string() }).passthrough()).optional() }).passthrough()),
});

const VulnSchema = z
  .object({
    id: z.string(),
    summary: z.string().optional(),
    details: z.string().optional(),
    aliases: z.array(z.string()).optional(),
    database_specific: z.object({ severity: z.string().optional() }).passthrough().optional(),
    affected: z
      .array(
        z
          .object({
            package: z.object({ name: z.string(), ecosystem: z.string() }).passthrough().optional(),
            ranges: z.array(z.object({ events: z.array(z.record(z.string())) }).passthrough()).optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
export type OsvVuln = z.infer<typeof VulnSchema>;

export interface VulnHit {
  dep: Dependency;
  id: string;
  summary: string;
  severity: string;
  fixed?: string;
}

export const OSV_API = "https://api.osv.dev/v1";

/** Query the OSV batch API (https://api.osv.dev/v1/querybatch) then fetch details for each distinct vuln. */
export async function queryOsv(deps: Dependency[], fetchImpl: typeof fetch = fetch, maxDetails = 50): Promise<VulnHit[]> {
  const hits: Array<{ dep: Dependency; id: string }> = [];
  for (let i = 0; i < deps.length; i += 1000) {
    const chunk = deps.slice(i, i + 1000);
    const res = await fetchImpl(`${OSV_API}/querybatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queries: chunk.map((d) => ({ package: { name: d.name, ecosystem: d.ecosystem }, version: d.version })) }),
    });
    if (!res.ok) throw new Error(`OSV querybatch HTTP ${res.status}`);
    const body = BatchResponse.parse(await res.json());
    body.results.forEach((r, j) => {
      const dep = chunk[j];
      if (dep) for (const v of r.vulns ?? []) hits.push({ dep, id: v.id });
    });
  }
  const details = new Map<string, OsvVuln | null>();
  for (const id of [...new Set(hits.map((h) => h.id))].slice(0, maxDetails)) {
    try {
      const res = await fetchImpl(`${OSV_API}/vulns/${encodeURIComponent(id)}`);
      details.set(id, res.ok ? VulnSchema.parse(await res.json()) : null);
    } catch {
      details.set(id, null);
    }
  }
  return hits.map(({ dep, id }) => {
    const v = details.get(id) ?? null;
    let fixed: string | undefined;
    for (const a of v?.affected ?? []) {
      if (a.package && a.package.name.toLowerCase() !== dep.name.toLowerCase()) continue;
      for (const r of a.ranges ?? []) for (const e of r.events) if (e.fixed) fixed = e.fixed;
    }
    return { dep, id, summary: v?.summary ?? v?.details?.slice(0, 120) ?? "known vulnerability", severity: v?.database_specific?.severity ?? "UNKNOWN", fixed };
  });
}

export function vulnFindings(hits: VulnHit[]): Finding[] {
  return hits.map((h) => ({
    file: h.dep.file,
    line: h.dep.line,
    rule: `osv/${h.id}`,
    message: `${h.dep.name}@${h.dep.version}${h.dep.approximate ? " (declared range)" : ""}: ${h.summary} [${h.severity}]${h.fixed ? ` — fixed in ${h.fixed}` : ""}`,
    severity: h.severity.toUpperCase() === "LOW" ? "warning" : "error",
  }));
}

export function vulnFix(hits: VulnHit[]): string {
  const byPkg = new Map<string, VulnHit[]>();
  for (const h of hits) byPkg.set(`${h.dep.ecosystem}:${h.dep.name}@${h.dep.version}`, [...(byPkg.get(`${h.dep.ecosystem}:${h.dep.name}@${h.dep.version}`) ?? []), h]);
  const lines: string[] = [];
  for (const list of byPkg.values()) {
    const d = list[0]!.dep;
    const fixed = list.map((h) => h.fixed).filter((x): x is string => Boolean(x)).sort(cmpVersion).pop();
    const ids = list.map((h) => h.id).join(", ");
    const cmd = d.ecosystem === "npm" ? `npm install ${d.name}@${fixed ?? "latest"}` : `pip install "${d.name}>=${fixed ?? "<patched>"}"`;
    lines.push(`- Upgrade ${d.name} ${d.version} → ${fixed ?? "a patched version"} (${ids}): \`${cmd}\``);
  }
  return `Upgrade vulnerable dependencies and regenerate the lockfile:\n${lines.join("\n")}`;
}

function cmpVersion(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
