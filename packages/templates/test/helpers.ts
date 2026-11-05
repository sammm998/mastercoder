import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";

export interface RunResult {
  code: number;
  output: string;
}

/** Run a shell command; resolves with exit code + combined output (tail-truncated). */
export function run(cmd: string, cwd: string, timeoutMs = 600_000, env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd, shell: true, env: { ...process.env, CI: "1", NEXT_TELEMETRY_DISABLED: "1", ASTRO_TELEMETRY_DISABLED: "1", ...env } });
    let output = "";
    const add = (b: Buffer) => {
      output += b.toString();
      if (output.length > 200_000) output = output.slice(-100_000);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output });
    });
  });
}

/** Run and throw with the last lines of output on failure. */
export async function mustRun(cmd: string, cwd: string, timeoutMs?: number): Promise<string> {
  const r = await run(cmd, cwd, timeoutMs);
  if (r.code !== 0) throw new Error(`\`${cmd}\` failed (exit ${r.code}) in ${cwd}:\n${r.output.slice(-6000)}`);
  return r.output;
}

async function walk(dir: string, out: string[] = [], rel = ""): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".venv") continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await walk(join(dir, e.name), out, r);
    else out.push(r);
  }
  return out;
}

/**
 * Syntax-validate a scaffolded project without installing it: every JSON parses, every TS/TSX/JS
 * file has no syntactic diagnostics, every .astro file has a closed frontmatter fence.
 */
export async function validateSyntax(dir: string): Promise<string[]> {
  const errors: string[] = [];
  for (const f of await walk(dir)) {
    const text = await readFile(join(dir, f), "utf8");
    if (f.endsWith(".json") && !f.startsWith("tsconfig")) {
      try {
        JSON.parse(text);
      } catch (e) {
        errors.push(`${f}: ${(e as Error).message}`);
      }
    } else if (/\.(m?[jt]sx?)$/.test(f) && !f.endsWith(".d.ts")) {
      const out = ts.transpileModule(text, { fileName: f, reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
      for (const d of out.diagnostics ?? []) errors.push(`${f}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
    } else if (f.endsWith(".astro")) {
      const fences = text.split("\n").filter((l) => l.trim() === "---").length;
      if (fences !== 0 && fences !== 2) errors.push(`${f}: unbalanced frontmatter fence`);
      const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1];
      if (fm) {
        const out = ts.transpileModule(fm, { fileName: `${f}.ts`, reportDiagnostics: true });
        for (const d of out.diagnostics ?? []) errors.push(`${f} (frontmatter): ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
      }
    }
  }
  return errors;
}
