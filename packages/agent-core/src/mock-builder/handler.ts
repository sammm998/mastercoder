import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { importOpenApi, parseOpenApiDocument, type ImportedApi } from "@forge/integrations";
import type { CompletionRequest, ContentBlock } from "@forge/llm";
import type { Spec } from "../spec.js";
import { exitCodeOf, fileFromReadResult, parseConversation, type Conversation, type Round, type ToolCall, type ToolOutcome } from "./conversation.js";
import { improveContrast } from "./design-fix.js";
import { addPublicMarker, addSessionCheck, parseGateFailures, planAuthFix, rlsSqlFromFix, shortHash, type AuthPlan } from "./fixes.js";
import { UnsupportedBuildError, generateProject } from "./generate.js";
import { HEADER, SQL_HEADER } from "./names.js";
import type { GeneratedProject } from "./types.js";

/**
 * Rule-based handler for LLM purpose "agent.build" (LLM_PROVIDER=mock). It is a deterministic,
 * template-based code generator driven by a small state machine over the conversation: every tool
 * call id encodes its phase (`mb-<phase>[-<sig>]-<n>`), so the next step follows from what was
 * already done and what the tool results said. It never claims to be a model.
 */

type Reply = string | ContentBlock[];

const LABEL = `${HEADER}: a deterministic, template-based code generator, not a language model.`;

function tool(phase: string, n: number, name: string, input: Record<string, unknown>, sig?: string): ContentBlock {
  return { type: "tool_use", id: `mb-${phase}${sig ? `-${sig}` : ""}-${n}`, name, input };
}

const inPhase = (r: Round, phase: string) => r.calls.filter((c) => c.id.startsWith(`mb-${phase}-`));
const failed = (calls: Array<{ result?: ToolOutcome }>) => calls.filter((c) => exitCodeOf(c.result) !== 0);

function verifyCalls(phase: string, commands: string[], hasTests: boolean, sig?: string): ContentBlock[] {
  const out = commands.map((cmd, i) => tool(phase, i, "run_command", { command: cmd, timeoutSec: 900 }, sig));
  if (hasTests) out.push(tool(phase, commands.length, "run_tests", {}, sig));
  return out;
}

function describeChecks(calls: Array<ToolCall & { result?: ToolOutcome }>): string[] {
  return calls.map((c) => {
    const what = c.name === "run_tests" ? "tests" : String(c.input.command ?? c.name);
    const code = exitCodeOf(c.result);
    if (code === 0) return `- ✓ ${what}`;
    const tail = (c.result?.content ?? "").trim().split("\n").slice(-8).join("\n    ");
    return `- ✗ ${what} (exit ${code ?? "?"})\n    ${tail}`;
  });
}

// ------------------------------------------------------------------ inputs

function listedFiles(round: Round): string[] {
  const res = inPhase(round, "discover").find((c) => c.name === "list_files")?.result;
  const fromList = res && !res.isError ? res.content.split("\n").map((l) => l.trim()).filter((l) => l && l !== "(empty)" && !l.startsWith("…")) : [];
  const fromMap = [...round.repoMap.matchAll(/^(\S+) \(\d+L\)/gm)].map((m) => m[1]!);
  return [...new Set([...fromList, ...fromMap])].sort();
}

/** An OpenAPI document the spec points at (path inside the project, or a bundled evals fixture). */
export function openApiPathOf(spec: Spec): string | null {
  const text = [spec.summary, ...spec.userStories, ...spec.integrations, spec.designNotes].join("\n");
  if (!/openapi|swagger|\bapi\b/i.test(text)) return null;
  const m = /((?:\.\/)?[\w-]+(?:\/[\w.-]+)*\.(?:json|ya?ml))\b/.exec(text);
  return m?.[1] ? m[1].replace(/^\.\//, "") : null;
}

const FIXTURE = /^evals\/fixtures\/[\w.-]+\.(json|ya?ml)$/;

async function parseApi(text: string): Promise<ImportedApi | null> {
  try {
    return parseOpenApiDocument(JSON.parse(text));
  } catch {
    try {
      return await importOpenApi(text);
    } catch {
      return null;
    }
  }
}

async function loadOpenApi(path: string, round: Round): Promise<{ api: ImportedApi; name: string } | undefined> {
  let text = fileFromReadResult(inPhase(round, "discover").find((c) => c.name === "read_file")?.result);
  if (text === null && FIXTURE.test(path)) {
    // Benchmark fixtures ship with the Forge repo (only this directory is readable from the host).
    try {
      text = await readFile(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), "utf8");
    } catch {
      text = null;
    }
  }
  if (text === null) return undefined;
  const api = await parseApi(text);
  return api ? { api, name: path } : undefined;
}

// ------------------------------------------------------------------ build round

function postPath(path: string, setupOutput: string): string {
  const tail = path.replace(/^(.*\/)\d{4}_/, "");
  const m = new RegExp(`([\\w/.-]*\\d{4}_${tail.replace(/[.]/g, "\\.")})`).exec(setupOutput);
  return m?.[1] ?? path;
}

function finalBuildText(gen: GeneratedProject, round: Round, spec: Spec, templateId: string, extra: string[] = []): string {
  const checks = [...inPhase(round, "verify"), ...inPhase(round, "reverify")];
  const last = inPhase(round, "reverify").length ? inPhase(round, "reverify") : inPhase(round, "verify");
  const ok = last.length > 0 && failed(last).length === 0;
  const setup = inPhase(round, "setup")[0];
  return [
    LABEL,
    ``,
    `Built "${spec.title}" from the spec with the ${gen.generator} generator on the ${templateId} template: ${Object.keys(gen.files).length + Object.keys(gen.postFiles).length} files written.`,
    setup ? `Setup (${String(setup.input.command)}): ${exitCodeOf(setup.result) === 0 ? "ok" : `failed (exit ${exitCodeOf(setup.result)})`}.` : "",
    inPhase(round, "autofix").length ? `Ran the auto-fixer once (${gen.autofix}) after the first verification failed.` : "",
    ``,
    `Verification ${ok ? "passed" : "did NOT fully pass"}:`,
    ...describeChecks(last.length ? last : checks),
    ``,
    `Assumptions and limitations:`,
    ...gen.notes.map((n) => `- ${n}`),
    ...extra.map((n) => `- ${n}`),
  ]
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n")
    .trim();
}

async function buildRound(conv: Conversation): Promise<Reply> {
  const { round, spec, templateId } = conv;
  if (!spec || !templateId) return `${LABEL}\n\nI could not find the spec JSON or the template id in the build prompt, so nothing was generated.`;
  if (spec.kind === "website" || templateId === "astro-site") return verifyOnlyRound(conv, "website");

  const apiPath = openApiPathOf(spec);
  if (!inPhase(round, "discover").length) {
    const calls = [tool("discover", 0, "list_files", { dir: ".", recursive: true })];
    if (apiPath) calls.push(tool("discover", 1, "read_file", { path: apiPath }));
    return calls;
  }
  const files = listedFiles(round);
  const openapi = apiPath ? await loadOpenApi(apiPath, round) : undefined;
  let gen: GeneratedProject;
  try {
    gen = generateProject({ spec, templateId, files, openapi });
  } catch (e) {
    if (e instanceof UnsupportedBuildError) return `${LABEL}\n\nNot built: ${e.message}`;
    throw e;
  }
  if (gen.generator.startsWith("unsupported:")) return verifyOnlyRound(conv, "unsupported");
  const extra = apiPath && !openapi ? [`The spec mentions ${apiPath}, but it could not be read or parsed as OpenAPI, so no API client was generated.`] : [];

  if (!inPhase(round, "write").length) {
    return Object.entries(gen.files)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, content], i) => tool("write", i, "write_file", { path, content }));
  }
  if (gen.setup.length && !inPhase(round, "setup").length) return [tool("setup", 0, "run_command", { command: gen.setup.join(" && "), timeoutSec: 1200 })];
  const post = Object.entries(gen.postFiles);
  if (post.length && !inPhase(round, "post").length) {
    const out = inPhase(round, "setup")[0]?.result?.content ?? "";
    return post.map(([path, content], i) => tool("post", i, "write_file", { path: postPath(path, out), content }));
  }
  const verify = inPhase(round, "verify");
  if (!verify.length) return verifyCalls("verify", gen.verify, true);
  if (failed(verify).length && gen.autofix && !inPhase(round, "autofix").length) return [tool("autofix", 0, "run_command", { command: gen.autofix, timeoutSec: 600 })];
  if (inPhase(round, "autofix").length && !inPhase(round, "reverify").length) return verifyCalls("reverify", gen.verify, true);
  return finalBuildText(gen, round, spec, templateId, extra);
}

/** Websites (design engine wrote the files), follow-ups and templates without a generator: verify only. */
function verifyOnlyRound(conv: Conversation, why: "website" | "followup" | "unsupported"): Reply {
  const { round, commands } = conv;
  const cmds = [commands.typecheck, commands.lint].filter((c): c is string => Boolean(c));
  const verify = inPhase(round, "verify");
  if (!verify.length && (cmds.length || commands.test)) return verifyCalls("verify", cmds, Boolean(commands.test));
  const reason = {
    website: "The design engine composed this site; the mock builder only verified it.",
    followup: "Follow-up requests in free text are not interpreted offline: no files were changed, the project was only re-verified. A real model is needed for this change.",
    unsupported: `There is no rule-based generator for the ${conv.templateId ?? "unknown"} template; the scaffold was only verified.`,
  }[why];
  return [LABEL, "", reason, "", `Verification ${failed(verify).length ? "did NOT fully pass" : "passed"}:`, ...describeChecks(verify)].join("\n");
}

// ------------------------------------------------------------------ fix rounds

function failureTextOf(round: Round): string {
  if (round.kind === "strategy") return round.text.split("\nError:\n").pop() ?? round.text;
  if (round.kind === "replan") return round.text.split("\nPrevious error:\n").pop() ?? round.text;
  return round.text;
}

async function fixRound(conv: Conversation): Promise<Reply> {
  const { round, spec } = conv;
  if (!inPhase(round, "discover").length) return [tool("discover", 0, "list_files", { dir: ".", recursive: true })];
  const files = new Set(listedFiles(round));
  const failures = parseGateFailures(failureTextOf(round));
  const python = conv.templateId === "fastapi" || files.has("pyproject.toml");
  const autofixCmd = python ? ".venv/bin/ruff check --fix . ; .venv/bin/ruff format ." : "npx eslint . --fix";

  const auth: AuthPlan[] = [];
  const rlsSql: string[] = [];
  let lint = false;
  const unfixable: string[] = [];
  for (const f of failures) {
    if (f.gate === "auth") {
      for (const finding of f.findings.filter((x) => x.rule === "auth/missing-check")) auth.push(planAuthFix(finding, spec, files));
    } else if (f.gate === "rls") {
      const sql = rlsSqlFromFix(f.fix, files.has("drizzle/0000_forge_rls.sql"));
      if (sql.length) rlsSql.push(...sql);
      else unfixable.push("rls: the proposed fix had no SQL statements to apply");
    } else if (f.gate === "lint") lint = true;
    else unfixable.push(`${f.gate}: ${f.findings[0]?.message ?? "failed"}${f.findings.length > 1 ? ` (+${f.findings.length - 1} more)` : ""}`);
  }
  for (const a of auth) if (a.kind === "none") unfixable.push(`auth: ${a.file ?? "?"} — ${a.reason}`);
  const fixableAuth = auth.filter((a): a is Exclude<AuthPlan, { kind: "none" }> => a.kind !== "none");
  const plan = { auth: fixableAuth, rls: rlsSql, lint };
  const sig = shortHash(JSON.stringify(plan));
  const actionable = fixableAuth.length > 0 || rlsSql.length > 0 || lint;
  const triedBefore = conv.earlierCalls.some((c) => c.id.includes(`-${sig}-`));

  if (!actionable || triedBefore) {
    return [
      LABEL,
      "",
      triedBefore ? "These failures persist after the deterministic fixes I already applied in an earlier round; I have no other rule-based fix." : "No deterministic fix applies to these failures.",
      ...(unfixable.length ? ["", "Needs a real model or a human:", ...unfixable.map((u) => `- ${u}`)] : []),
    ].join("\n");
  }

  const drizzle = files.has("drizzle.config.ts") || files.has("drizzle.config.js");
  const authFiles = [...new Set(fixableAuth.map((a) => a.file))];
  if (!inPhase(round, "fread").length && (authFiles.length || (rlsSql.length && drizzle))) {
    const calls = authFiles.map((p, i) => tool("fread", i, "read_file", { path: p }, sig));
    if (rlsSql.length && drizzle) calls.push(tool("fread", authFiles.length, "run_command", { command: "npx drizzle-kit generate --custom --name forge_rls_fix", timeoutSec: 300 }, sig));
    return calls;
  }
  const applied: string[] = [];
  if (!inPhase(round, "fapply").length) {
    const writes: ContentBlock[] = [];
    const reads = inPhase(round, "fread");
    authFiles.forEach((p) => {
      const original = fileFromReadResult(reads.find((c) => c.name === "read_file" && c.input.path === p)?.result);
      if (original === null) return;
      let content: string = original;
      // Apply bottom-up so earlier line numbers stay valid.
      for (const a of fixableAuth.filter((x) => x.file === p).sort((x, y) => y.line - x.line)) {
        const next: string | null = a.kind === "public" ? addPublicMarker(content, p, a.line, a.reason) : addSessionCheck(content, a.line, a.framework);
        if (next) content = next;
      }
      writes.push(tool("fapply", writes.length, "write_file", { path: p, content }, sig));
    });
    if (rlsSql.length) {
      const out = reads.find((c) => c.name === "run_command")?.result?.content ?? "";
      const path = /(drizzle\/\d{4}_forge_rls_fix\.sql)/.exec(out)?.[1] ?? (drizzle ? null : "migrations/forge_rls_fix.sql");
      if (path) writes.push(tool("fapply", writes.length, "write_file", { path, content: `${SQL_HEADER}\n-- Row-level security from the quality gate's proposed fix.\n${rlsSql.join("\n--> statement-breakpoint\n")}\n` }, sig));
    }
    if (writes.length) return writes;
  }
  if (lint && !inPhase(round, "ffix").length) return [tool("ffix", 0, "run_command", { command: autofixCmd, timeoutSec: 600 }, sig)];
  const verify = inPhase(round, "fverify");
  const cmds = [conv.commands.typecheck, conv.commands.lint].filter((c): c is string => Boolean(c));
  if (!verify.length && (cmds.length || conv.commands.test)) return verifyCalls("fverify", cmds, Boolean(conv.commands.test), sig);

  for (const c of inPhase(round, "fapply")) applied.push(`- wrote ${String(c.input.path)}`);
  for (const a of fixableAuth) applied.push(a.kind === "public" ? `- marked ${a.file}:${a.line} \`forge:public\` (${a.reason})` : `- added a session check to ${a.file}:${a.line}`);
  if (inPhase(round, "ffix").length) applied.push(`- ran ${autofixCmd}`);
  return [
    LABEL,
    "",
    "Applied deterministic fixes:",
    ...applied,
    ...(unfixable.length ? ["", "Not fixed (needs a real model or a human):", ...unfixable.map((u) => `- ${u}`)] : []),
    "",
    `Re-verification ${failed(verify).length ? "still fails" : "passed"}:`,
    ...describeChecks(verify),
  ].join("\n");
}

// ------------------------------------------------------------------ design + review rounds

function designRound(conv: Conversation): Reply {
  const { round } = conv;
  const notes = round.text.split("keeping performance and accessibility:\n").pop() ?? "";
  if (!/contrast|legib|readab|wcag/i.test(notes)) return `${LABEL}\n\nThe critic's notes ask for visual changes I cannot make deterministically (only contrast fixes in tokens.css are rule-based). Notes:\n${notes.slice(0, 1500)}`;
  const path = /^(\S*tokens\.css) /m.exec(round.repoMap)?.[1] ?? "src/styles/tokens.css";
  if (!inPhase(round, "dread").length) return [tool("dread", 0, "read_file", { path })];
  const css = fileFromReadResult(inPhase(round, "dread")[0]?.result);
  if (css === null) return `${LABEL}\n\nCould not read ${path}; no design change was made.`;
  const { css: next, changes } = improveContrast(css);
  if (!changes.length) return `${LABEL}\n\n${path} already meets the contrast targets (text 7:1, muted 4.5:1, button text 4.5:1); the remaining critic notes need a real model:\n${notes.slice(0, 1500)}`;
  if (!inPhase(round, "dapply").length) return [tool("dapply", 0, "write_file", { path, content: next })];
  if (conv.commands.test && !inPhase(round, "dverify").length) return verifyCalls("dverify", [], true);
  return [LABEL, "", `Raised contrast in ${path}:`, ...changes.map((c) => `- ${c}`), "", ...describeChecks(inPhase(round, "dverify"))].join("\n");
}

function reviewRound(conv: Conversation): Reply {
  return `${LABEL}\n\nThe reviewer's findings need judgement, which the rule-based builder cannot provide; nothing was changed:\n${conv.round.text.split("\n").slice(1, 20).join("\n")}`;
}

export async function mockBuildHandler(req: CompletionRequest): Promise<Reply> {
  const conv = parseConversation(req.messages);
  switch (conv.round.kind) {
    case "build":
      return buildRound(conv);
    case "followup":
      return verifyOnlyRound(conv, "followup");
    case "fix":
    case "strategy":
    case "replan":
      return fixRound(conv);
    case "design":
      return designRound(conv);
    case "review":
      return reviewRound(conv);
    default:
      return `${LABEL}\n\nI did not recognise this request; nothing was changed.`;
  }
}
