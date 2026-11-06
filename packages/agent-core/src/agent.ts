import type { ChatMessage, LLMProvider } from "@forge/llm";
import type { IntentKind } from "@forge/shared";
import { getModels, textOf } from "@forge/llm";
import type { AgentDeps, BuildInput, GateReportLike, TemplateManifestLike } from "./ports.js";
import type { Spec } from "./spec.js";
import { SpecSchema } from "./spec.js";
import { plan } from "./planner.js";
import { review } from "./reviewer.js";
import { LoopGuard, type GuardDecision } from "./loop-guard.js";
import { pickModel } from "./router.js";
import { runToolLoop } from "./tool-loop.js";
import { buildTools, type ToolRuntime } from "./tools.js";
import { RepoMap } from "./context/repo-map.js";
import { MemoryVectorIndex, type VectorIndex } from "./context/embeddings.js";
import { BUILDER_SYSTEM, buildPrompt, fixPrompt, strategyPrompt } from "./prompts.js";

export type BuildStatus = "succeeded" | "failed" | "awaiting_approval" | "cancelled";

export interface BuildOutcome {
  status: BuildStatus;
  /** False when the failure was the agent's own (loop guard, gates never passed): the user is not charged. */
  charged: boolean;
  reason?: string;
  blockedOn?: string;
  spec?: Spec;
  template?: string;
  gateReport?: GateReportLike;
  designScore?: number;
  checkpoint?: { checkpointId: string; commit: string; snapshotId: string; dbBranchId?: string };
  previewUrl?: string;
  summary: string;
  costUsd: number;
  fixIterations: number;
}

export interface BuildAgentOptions {
  maxFixIterations?: number;
  sameErrorLimit?: number;
  designRounds?: number;
  designThreshold?: number;
  maxTurnsPerRound?: number;
  vectorIndex?: VectorIndex;
}

const CODE_KINDS: IntentKind[] = ["app", "website", "mobile", "backend"];

export function primaryKind(intents: BuildInput["intents"]): Spec["kind"] {
  const k = intents.find((i) => CODE_KINDS.includes(i.kind))?.kind;
  return (k as Spec["kind"] | undefined) ?? "app";
}

function summarizeGates(r: GateReportLike): string {
  return r.blockers
    .map((b) => {
      const finds = b.findings.slice(0, 8).map((f) => `  - ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""} ` : ""}[${f.rule}] ${f.message}`);
      return `### ${b.gate} FAILED\n${b.details.slice(0, 1500)}\n${finds.join("\n")}${b.fix ? `\nProposed fix: ${b.fix}` : ""}`;
    })
    .join("\n\n");
}

/**
 * The Forge build agent: PLAN → DESIGN → BUILD → VERIFY → REVIEW → FINISH with a loop guard.
 * Only code deliverables (app/website/mobile/backend) run here; media/slides/agents are separate pipelines.
 */
export class BuildAgent {
  private readonly o: Required<Omit<BuildAgentOptions, "vectorIndex">> & { vectorIndex?: VectorIndex };
  constructor(
    private readonly deps: AgentDeps,
    opts: BuildAgentOptions = {},
  ) {
    this.o = { maxFixIterations: 5, sameErrorLimit: 3, designRounds: 3, designThreshold: 8, maxTurnsPerRound: 60, ...opts };
  }

  private costOf(llm: LLMProvider): number {
    return (llm as { totalCostUsd?: number }).totalCostUsd ?? 0;
  }

  async run(input: BuildInput): Promise<BuildOutcome> {
    const { deps } = this;
    const ev = (e: Parameters<AgentDeps["events"]["emit"]>[0]) => deps.events.emit(e);
    const base = { projectId: input.projectId, taskId: input.taskId };
    const phaseStart = new Map<string, number>();
    const phase = (p: "plan" | "design" | "build" | "verify" | "review" | "finish") => {
      phaseStart.set(p, Date.now());
      ev({ type: "phase.started", ...base, phase: p });
    };
    const phaseDone = (p: string) => ev({ type: "phase.completed", ...base, phase: p, durationMs: Date.now() - (phaseStart.get(p) ?? Date.now()) });
    type Member = "scoutr" | "plania" | "pixel" | "byggo" | "vakt" | "revy";
    /** Agent-team conversation reflecting the real work of each step (rendered with avatars in the UI). */
    const team = (from: Member, to: Member | "user" | undefined, status: "asking" | "working" | "done" | "failed", step: string, key: string, params: Record<string, string | number>, text: string) =>
      ev({ type: "team.message", ...base, from, to, status, step, key, params, text });
    let extraCost = 0;
    const cost = () => this.costOf(deps.llm) || extraCost;
    const kind = primaryKind(input.intents);

    // ---------- PLAN ----------
    phase("plan");
    team("scoutr", "plania", "asking", "plan", "team.plan.ask", { request: input.prompt.slice(0, 140) }, `Plania, can you plan this? "${input.prompt.slice(0, 140)}"`);
    let spec: Spec;
    if (input.approvedSpec) {
      spec = SpecSchema.parse(input.approvedSpec);
    } else {
      const hint = input.intents.find((i) => i.hint)?.hint;
      const templateHint = deps.templates.select(kind, hint);
      const p = await plan(deps.llm, { prompt: input.prompt, intents: input.intents, projectContext: input.existingProject ? input.history : undefined, kind, templateHint });
      spec = p.spec;
      extraCost += p.costUsd;
    }
    phaseDone("plan");
    team("plania", "scoutr", "done", "plan", "team.plan.done", { title: spec.title, stories: spec.userStories.length, entities: spec.entities.length, tests: spec.acceptanceTests.length }, `Done ✓ "${spec.title}": ${spec.userStories.length} user stories, ${spec.entities.length} data entities, ${spec.acceptanceTests.length} acceptance tests — back to you, Scoutr`);
    {
      // Pre-build review: Vakt flags what the spec requires security-wise before any code is written.
      const owner = spec.entities.filter((e) => e.ownerScoped).length;
      const checks = [spec.auth ? "auth on every non-public route" : null, owner ? `row-level security on ${owner} table(s)` : null, spec.entities.length ? "zod validation on every write" : null, "no secrets in client code"].filter(Boolean) as string[];
      team("vakt", "byggo", "done", "kickoff", "team.kickoff.security", { checks: checks.join(" · ") }, `Before you start, Byggo: the gates will require ${checks.join(", ")}.`);
    }
    const proposeDesign = !input.approvedSpec && !input.existingProject && input.wantsDesignOptions && deps.design?.proposeDirections && kind !== "backend";
    if ((input.planMode || proposeDesign) && !input.approvedSpec) {
      if (proposeDesign) {
        phase("design");
        team("scoutr", "pixel", "asking", "design", "team.design.propose", {}, "Pixel, can you sketch three design directions to choose from?");
        const dirs = await deps.design!.proposeDirections!({ brief: input.prompt, spec, kind, brand: input.brand }).catch((e: unknown) => {
          ev({ type: "message", ...base, role: "system", text: `Design proposals unavailable: ${(e instanceof Error ? e.message : String(e)).slice(0, 400)}` });
          return [] as unknown[];
        });
        if (dirs.length) {
          ev({ type: "design.directions", ...base, directions: dirs, requiresChoice: true });
          team("pixel", "user", "done", "design", "team.design.proposed", { count: dirs.length }, `Here are ${dirs.length} directions — pick the one you like and I'll build it.`);
        }
        phaseDone("design");
      }
      ev({ type: "plan.ready", ...base, spec, requiresApproval: true });
      return { status: "awaiting_approval", charged: false, spec, summary: "Plan ready for approval.", costUsd: cost(), fixIterations: 0 };
    }
    ev({ type: "plan.ready", ...base, spec, requiresApproval: false });

    // ---------- SCAFFOLD ----------
    const templateId = spec.template ?? deps.templates.select(kind);
    let manifest: TemplateManifestLike | null = null;
    try {
      manifest = deps.templates.manifest(templateId);
    } catch {
      manifest = null;
    }
    const repoMap = new RepoMap();
    const index = this.o.vectorIndex ?? new MemoryVectorIndex();
    const touched = new Set<string>();
    let previewUrl: string | null = null;
    if (!input.existingProject) {
      const written = await deps.templates.scaffold(templateId, { writeFile: (p, c) => deps.sandbox.writeFile(p, c) }, { projectName: spec.title, projectSlug: slug(spec.title) });
      for (const p of written) ev({ type: "file.changed", ...base, path: p, change: "created" });
    }
    const allFiles = await deps.sandbox.listFiles(".", { recursive: true });
    await repoMap.refresh(allFiles, (p) => deps.sandbox.readFile(p));
    for (const s of repoMap.symbols()) await index.upsertFile(input.projectId, s.path, await deps.sandbox.readFile(s.path));
    if (manifest?.install) {
      const r = await deps.sandbox.exec(fastInstall(manifest.install), { timeoutMs: 900_000 });
      ev({ type: "terminal.output", ...base, stream: r.exitCode === 0 ? "stdout" : "stderr", text: `$ ${manifest.install}\n${(r.stdout + r.stderr).slice(-3000)}` });
    }

    // ---------- DESIGN ----------
    let designDirection = "";
    // Follow-ups keep the existing design: re-composing would overwrite the user's site.
    if (deps.design && kind !== "backend" && !input.existingProject) {
      phase("design");
      team("scoutr", "pixel", "asking", "design", "team.design.ask", {}, "Pixel, can you set the art direction?");
      // A design-engine failure never ends the build: the builder designs from the plan instead.
      const d = await deps.design.artDirection({ brief: input.prompt, spec, kind, brand: input.brand, direction: input.designDirection }).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        ev({ type: "message", ...base, role: "system", text: `Design engine failed, continuing without it: ${msg.slice(0, 800)}` });
        team("pixel", "byggo", "failed", "design", "team.design.fallback", {}, "Pixel hit a snag with the art direction, so Byggo will design it directly from the plan.");
        return null;
      });
      if (d) {
        designDirection = d.directionName;
        const tokenFiles = allFiles.filter((f) => f.endsWith("tokens.css"));
        for (const f of tokenFiles.length ? tokenFiles : ["src/styles/tokens.css"]) {
          await deps.sandbox.writeFile(f, d.tokensCss);
          touched.add(f);
          await repoMap.update(f, d.tokensCss);
        }
        const composed = d.files ?? {};
        if (composed["package.json"]) {
          // The design engine composed a complete project: drop scaffold files it does not contain (their
          // tests/imports target the starter app) and align forge.json + the manifest with its scripts.
          for (const f of allFiles) {
            if (composed[f] || f === "forge.json" || f.startsWith(".git")) continue;
            await deps.sandbox.exec(`rm -f -- ${JSON.stringify(f)}`, { timeoutMs: 10_000 });
            repoMap.remove(f);
            await index.removeFile(input.projectId, f);
          }
          const scripts = (JSON.parse(composed["package.json"]) as { scripts?: Record<string, string> }).scripts ?? {};
          const port = manifest?.port ?? 5173;
          manifest = {
            id: manifest?.id ?? templateId,
            kind: manifest?.kind ?? kind,
            install: "npm install",
            dev: scripts.dev ? `npm run dev -- --host 0.0.0.0 --port ${port}` : (manifest?.dev ?? "npm run dev"),
            build: scripts.build ? "npm run build" : undefined,
            typecheck: scripts.typecheck ? "npm run typecheck" : undefined,
            lint: scripts.lint ? "npm run lint" : undefined,
            // A composed site has no unit tests; the production build (tsc + vite build) is its test.
            test: scripts.test ? "npm test" : scripts.build ? "npm run build" : undefined,
            port,
            lighthouse: manifest?.lighthouse,
          };
          const forgeJson = { ...manifest, typecheck: manifest.typecheck ?? null, lint: manifest.lint ?? null, test: manifest.test ?? null, e2e: null, publicRoutes: ["/"] };
          await deps.sandbox.writeFile("forge.json", JSON.stringify(forgeJson, null, 2) + "\n");
        }
        for (const [p, c] of Object.entries(composed)) {
          await deps.sandbox.writeFile(p, c);
          touched.add(p);
          ev({ type: "file.changed", ...base, path: p, change: "modified" });
          await repoMap.update(p, c);
          await index.upsertFile(input.projectId, p, c);
        }
        if (composed["package.json"] && manifest?.install) {
          const r = await deps.sandbox.exec(fastInstall(manifest.install), { timeoutMs: 900_000 });
          ev({ type: "terminal.output", ...base, stream: r.exitCode === 0 ? "stdout" : "stderr", text: `$ ${manifest.install}\n${(r.stdout + r.stderr).slice(-3000)}` });
        }
        for (const a of d.assets ?? []) {
          await deps.sandbox.writeFile(a.path, a.bytes);
          touched.add(a.path);
          ev({ type: "file.changed", ...base, path: a.path, change: "created" });
        }
        if (d.assets?.length) designDirection += `\nGenerated images in the project (use them where they fit, with descriptive alt text): ${d.assets.map((a) => `${a.path} — ${a.description}`).join("; ")}`;
        ev({ type: "message", ...base, role: "system", text: `Art direction: ${d.directionName}` });
        team("pixel", "scoutr", "done", "design", "team.design.done", { direction: d.directionName, files: Object.keys(d.files ?? {}).length }, `Done ✓ art direction "${d.directionName}"${d.files ? `, composed ${Object.keys(d.files).length} files` : ""} — back to you, Scoutr`);
      }
      phaseDone("design");
    }

    // Live preview: start the dev server as soon as there is a UI (scaffold, composed design or an existing
    // project), in the background, so the user watches the site change while the builder works (HMR).
    if (deps.setup && kind !== "backend") {
      const prep = await deps.setup.prepare(deps.sandbox).catch(() => ({ packageJsonChanged: false, notes: [] as string[] }));
      if (prep.packageJsonChanged && manifest?.install) await deps.sandbox.exec(fastInstall(manifest.install), { timeoutMs: 900_000 });
      for (const n of prep.notes) ev({ type: "message", ...base, role: "system", text: n });
    }
    let earlyPreview: Promise<string | null> | null = null;
    if (manifest && kind !== "backend") {
      const m = manifest;
      earlyPreview = this.startPreview(m, input)
        .then((u) => (previewUrl ??= u))
        .catch(() => null);
    }
    const rt: ToolRuntime = { deps, projectId: input.projectId, taskId: input.taskId, repoMap, index, manifest: () => manifest, previewUrl: () => previewUrl, touched };
    const tools = buildTools(rt);
    const guard = new LoopGuard(this.o.maxFixIterations, this.o.sameErrorLimit);
    const history: ChatMessage[] = [];
    const round = async (userText: string, step: Parameters<typeof pickModel>[0]) => {
      const { model } = pickModel(step);
      history.push({ role: "user", content: `${userText}\n\n## Repository map\n${repoMap.render()}` });
      const r = await runToolLoop({
        llm: deps.llm,
        model,
        purpose: "agent.build",
        system: BUILDER_SYSTEM,
        messages: history,
        tools,
        events: deps.events,
        projectId: input.projectId,
        taskId: input.taskId,
        maxTurns: this.o.maxTurnsPerRound,
        isCancelled: deps.isCancelled,
      });
      history.splice(0, history.length, ...r.messages);
      extraCost += r.costUsd;
      return r;
    };
    const fail = (reason: string, blockedOn: string, gateReport?: GateReportLike): BuildOutcome => {
      team("scoutr", "user", "failed", "finish", "team.failed", { reason, blockedOn }, `I couldn't finish: ${reason}. You won't be charged.`);
      ev({ type: "task.failed", ...base, reason, charged: false, blockedOn });
      return { status: "failed", charged: false, reason, blockedOn, spec, template: templateId, gateReport, summary: reason, costUsd: cost(), fixIterations: guard.count, previewUrl: previewUrl ?? undefined };
    };
    const onGuard = async (d: GuardDecision, failureText: string): Promise<"stop" | "go"> => {
      if (d.action === "stop") return "stop";
      if (d.action === "change_strategy") {
        ev({ type: "message", ...base, role: "system", text: `Changing strategy (${d.strategy}): ${d.reason}` });
        let docs = "";
        if (d.strategy === "search_docs" && deps.docs) {
          const hits = await deps.docs.search(failureText.slice(0, 200));
          docs = hits.map((h) => `${h.title} ${h.url}\n${h.snippet}`).join("\n\n");
        }
        if (d.strategy === "replan") {
          const p = await plan(deps.llm, { prompt: input.prompt, intents: input.intents, projectContext: input.existingProject ? input.history : undefined, kind, templateHint: templateId, failureContext: failureText.slice(0, 4000) });
          spec = p.spec;
          extraCost += p.costUsd;
          ev({ type: "plan.ready", ...base, spec, requiresApproval: false });
        }
        await round(strategyPrompt(d.strategy, failureText, docs, spec), { phase: "fix", failures: 3, description: failureText });
      }
      return "go";
    };

    // ---------- BUILD ----------
    phase("build");
    team("scoutr", "byggo", "asking", "build", "team.build.ask", { tasks: spec.tasks.length || spec.userStories.length }, "Byggo, can you build it from the plan?");
    const buildStep = { phase: "build" as const, description: spec.summary, fileCount: spec.entities.length * 3 + spec.screens.length };
    // A round that ran out of turns continues where it stopped (up to 2 more times).
    const roundToEnd = async (text: string) => {
      let r = await round(text, buildStep);
      let toolCalls = r.toolCalls;
      for (let i = 0; i < 2 && r.stopReason === "max_turns"; i++) {
        r = await round("You ran out of steps in the last round. Continue exactly where you stopped and finish this step.", buildStep);
        toolCalls += r.toolCalls;
      }
      return { ...r, toolCalls };
    };
    const base0 = buildPrompt(spec, templateId, manifest, designDirection, input.existingProject ? input.prompt : undefined, input.existingProject ? input.history : undefined, input.prompt);
    let built: Awaited<ReturnType<typeof roundToEnd>>;
    const steps = spec.tasks;
    if (steps.length >= 4 && !input.existingProject) {
      // Large specs are built step by step: one round per planned task with a fresh context (spec + repo map),
      // so every step gets a full budget instead of the whole product sharing one.
      let toolCalls = 0;
      let last: Awaited<ReturnType<typeof roundToEnd>> | null = null;
      for (const [i, task] of steps.entries()) {
        if (await deps.isCancelled?.()) break;
        team("byggo", "scoutr", "working", "build", "team.build.step", { n: i + 1, total: steps.length, title: task.title }, `Step ${i + 1}/${steps.length}: ${task.title}`);
        history.splice(0, history.length);
        last = await roundToEnd(
          `${base0}\n\n## Now: step ${i + 1} of ${steps.length} — ${task.title}\nSteps already done: ${steps.slice(0, i).map((s) => s.title).join("; ") || "none"}.\nImplement this step completely and working (real logic, no placeholders), building on the files that exist. Run the relevant checks. Reply with a one-line summary when the step works.`,
        );
        toolCalls += last.toolCalls;
      }
      // Completion pass: every user story and acceptance test must be met by the code.
      history.splice(0, history.length);
      const check = await roundToEnd(
        `${base0}\n\n## Completion check\nGo through every user story and acceptance test above. For each one, check the code actually implements it end to end (open the files). Implement anything missing or stubbed, wire up every button and interaction, then run the checks. Reply with what you verified and what you fixed.`,
      );
      built = { ...(last ?? check), toolCalls: toolCalls + check.toolCalls };
    } else {
      built = await roundToEnd(base0);
    }
    phaseDone("build");
    team("byggo", "scoutr", built.toolErrors.length ? "failed" : "done", "build", "team.build.done", { files: touched.size, tools: built.toolCalls }, `Done ✓ ${touched.size} files written with ${built.toolCalls} tool calls — over to Vakt for checks`);
    if (deps.isCancelled && (await deps.isCancelled())) return { status: "cancelled", charged: false, spec, summary: "Cancelled by user", costUsd: cost(), fixIterations: 0 };

    // ---------- VERIFY + REVIEW loop ----------
    let gateReport: GateReportLike | undefined;
    let designScore: number | undefined;
    let designRoundsUsed = 0;
    let reviewed = false;
    for (;;) {
      phase("verify");
      if (manifest && kind !== "backend") {
        if (!previewUrl && earlyPreview) previewUrl = await earlyPreview;
        earlyPreview = null;
        // The builder may have changed scripts or crashed the server: restart it when it no longer answers.
        if (!previewUrl || !(await this.previewAlive(devPort(input.projectId)))) {
          await deps.sandbox.exec(`fuser -k ${devPort(input.projectId)}/tcp >/dev/null 2>&1 || true`, { timeoutMs: 10_000 });
          previewUrl = await this.startPreview(manifest, input);
        }
      }
      if (deps.design?.visualQa && previewUrl && kind === "website") {
        const qa = await deps.design.visualQa(previewUrl, { brief: input.prompt }).catch((e: unknown) => {
          ev({ type: "message", ...base, role: "system", text: `Visual QA unavailable, skipping the design score: ${(e instanceof Error ? e.message : String(e)).slice(0, 500)}` });
          return null;
        });
        if (qa) {
          designScore = qa.score;
          ev({ type: "design.score", ...base, score: qa.score, notes: `${qa.critic}: ${qa.notes}` });
          if (qa.score < this.o.designThreshold && designRoundsUsed < this.o.designRounds) {
            designRoundsUsed++;
            await round(`The design critic scored the site ${qa.score}/10 (needs ${this.o.designThreshold}). Revise per these notes, keeping performance and accessibility:\n${qa.notes}`, { phase: "fix", description: "design revision" });
            continue;
          }
        }
      }
      gateReport = await deps.gates.run(deps.sandbox, { previewUrl: previewUrl ?? undefined, visualScore: designScore });
      for (const r of gateReport.results) {
        const finds = r.findings.slice(0, 5).map((f) => `- ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""} ` : ""}[${f.rule}] ${f.message}`).join("\n");
        ev({ type: "gate.result", ...base, gate: r.gate, passed: r.passed || Boolean(r.skipped), details: (r.skipped ? `skipped: ${r.details}` : `${r.details}${finds ? `\n${finds}` : ""}`).slice(0, 2000), fix: r.fix });
      }
      phaseDone("verify");
      {
        const ran = gateReport.results.filter((r) => !r.skipped);
        const failed = gateReport.blockers.map((b) => b.gate);
        team("vakt", failed.length ? "byggo" : "scoutr", failed.length ? "failed" : "done", "verify", failed.length ? "team.verify.failed" : "team.verify.done", { passed: ran.filter((r) => r.passed).length, total: ran.length, failed: failed.join(", ") }, failed.length ? `${failed.length} check(s) failing: ${failed.join(", ")} — Byggo, please fix` : `Done ✓ ${ran.length} quality checks passed`);
      }
      if (!gateReport.passed) {
        const text = summarizeGates(gateReport);
        if ((await onGuard(guard.recordFailure(text), text)) === "stop") return fail(`Quality gates still failing after ${guard.count} fix attempts`, gateReport.blockers.map((b) => b.gate).join(", "), gateReport);
        const fixed = await round(fixPrompt(text), { phase: "fix", failures: guard.count, description: text });
        // The agent declined or could not act (no tool calls): re-running the same gates cannot help — stop now
        // instead of burning the remaining iterations (time and money).
        if (fixed.toolCalls === 0) return fail(`The agent could not fix the failing quality gates: ${gateReport.blockers.map((b) => b.gate).join(", ")}`, gateReport.blockers.map((b) => b.gate).join(", "), gateReport);
        continue;
      }
      if (!reviewed) {
        phase("review");
        reviewed = true;
        const files = await Promise.all([...touched].filter((p) => !p.endsWith(".lock")).map(async (p) => ({ path: p, content: await deps.sandbox.readFile(p).catch(() => "") })));
        const rv = await review(deps.llm, spec, files);
        extraCost += rv.costUsd;
        phaseDone("review");
        team("revy", "scoutr", rv.review.approved ? "done" : "failed", "review", rv.review.approved ? "team.review.done" : "team.review.issues", { issues: rv.review.issues.length }, rv.review.approved ? "Done ✓ code matches the plan — no blocking issues" : `${rv.review.issues.length} issue(s) found — sending back to Byggo`);
        if (!rv.review.approved && rv.review.issues.length) {
          const text = rv.review.issues.map((i) => `- ${i.file ? `${i.file}: ` : ""}${i.problem}\n  Fix: ${i.fix}`).join("\n");
          ev({ type: "message", ...base, role: "system", text: `Reviewer found ${rv.review.issues.length} issue(s)` });
          if ((await onGuard(guard.recordFailure(text), text)) === "stop") return fail("Reviewer issues could not be resolved", "review");
          const fixed = await round(`A reviewer with fresh context found these problems. Fix them:\n${text}`, { phase: "fix", failures: guard.count, description: text });
          if (fixed.toolCalls === 0) return fail("Reviewer issues could not be resolved", "review");
          continue;
        }
      }
      break;
    }

    // ---------- FINISH ----------
    phase("finish");
    let checkpoint: BuildOutcome["checkpoint"];
    if (deps.checkpoints) {
      checkpoint = await deps.checkpoints.create({ sandbox: deps.sandbox, projectId: input.projectId, taskId: input.taskId, label: spec.title });
      ev({ type: "checkpoint.created", ...base, checkpointId: checkpoint.checkpointId, commit: checkpoint.commit, label: spec.title });
    }
    if (previewUrl && deps.browser) {
      for (const vp of [375, 1440]) {
        try {
          const s = await deps.browser.screenshot(previewUrl, vp);
          ev({ type: "screenshot", ...base, url: s.url, viewport: vp });
        } catch {
          // screenshots are best-effort decoration of the summary
        }
      }
    }
    const summary = await this.summarize(spec, gateReport, designScore, touched.size);
    team("scoutr", "user", "done", "finish", "team.finish", { title: spec.title, files: touched.size }, `"${spec.title}" is ready and every check passed.`);
    phaseDone("finish");
    return { status: "succeeded", charged: true, spec, template: templateId, gateReport, designScore, checkpoint, previewUrl: previewUrl ?? undefined, summary, costUsd: cost(), fixIterations: guard.count };
  }

  private async startPreview(manifest: TemplateManifestLike, input: BuildInput): Promise<string | null> {
    const { sandbox, events } = this.deps;
    // FORGE_DEV_HOST (e.g. "::") lets the dev server listen on IPv6 private networks (Railway) for the preview proxy.
    // Every project gets its own dev port: sandboxes may share a host, and a fixed port (3000, 5173 …)
    // would show another project's running preview.
    const port = devPort(input.projectId);
    const base = process.env.FORGE_DEV_HOST ? manifest.dev.replace(/0\.0\.0\.0/g, process.env.FORGE_DEV_HOST) : manifest.dev;
    const dev = devCommand(base, manifest.port, port);
    await sandbox.exec(`nohup sh -c ${JSON.stringify(dev)} > .forge-dev.log 2>&1 &`, { timeoutMs: 15_000 });
    for (let i = 0; i < 120; i++) {
      if (await this.previewAlive(port)) {
        const { url } = await sandbox.exposePort(port);
        events.emit({ type: "preview.ready", projectId: input.projectId, taskId: input.taskId, url, port });
        return url;
      }
      await new Promise((res) => setTimeout(res, 1000));
    }
    return null;
  }

  /** HTTP probe of the dev server on IPv4 and IPv6 loopback, via node (no curl needed in the sandbox). */
  private async previewAlive(port: number): Promise<boolean> {
    const js = `const u=["http://127.0.0.1:${port}/","http://[::1]:${port}/"];(async()=>{for(const x of u){try{const r=await fetch(x,{signal:AbortSignal.timeout(4000),redirect:"manual"});if(r.status<500){console.log(r.status);return}}catch{}}console.log(0)})()`;
    const r = await this.deps.sandbox.exec(`node -e ${JSON.stringify(js)} 2>/dev/null || curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:${port}/ || true`, { timeoutMs: 12_000 });
    return /^[1-4]\d\d$/.test(r.stdout.trim());
  }

  private async summarize(spec: Spec, gates: GateReportLike | undefined, designScore: number | undefined, files: number): Promise<string> {
    const passed = gates?.results.filter((r) => r.passed && !r.skipped).map((r) => r.gate) ?? [];
    const facts = `Built "${spec.title}": ${spec.userStories.length} user stories, ${spec.entities.length} entities, ${files} files changed. Gates passed: ${passed.join(", ") || "none"}.${designScore !== undefined ? ` Design score ${designScore}/10.` : ""}`;
    try {
      const r = await this.deps.llm.complete({ purpose: "agent.summary", model: getModels().fast, system: "Write a 2-4 sentence plain-language summary of what was built and verified. No marketing language.", messages: [{ role: "user", content: `${facts}\nStories:\n${spec.userStories.join("\n")}` }], maxTokens: 600, effort: "low" });
      return textOf(r).trim() || facts;
    } catch {
      return facts;
    }
  }
}

/** npm installs skip the audit/fund network round-trips (the osv gate audits dependencies) and reuse the cache. */
export function fastInstall(cmd: string): string {
  return /^npm (install|i|ci)\b/.test(cmd.trim()) && !/--prefer-offline/.test(cmd) ? `${cmd} --prefer-offline --no-audit --no-fund --loglevel=error` : cmd;
}

function slug(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "app";
}

/** Stable per-project dev-server port (20000–39999). */
export function devPort(projectId: string): number {
  let h = 0;
  for (const c of projectId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 20000 + (h % 20000);
}

/** Point a dev command at `port`: rewrite --port/-p flags (or the template's default port) and set PORT. */
export function devCommand(cmd: string, defaultPort: number, port: number): string {
  let out = cmd.replace(/(--port[ =]|(?:^|\s)-p\s+)\d+/g, (m) => m.replace(/\d+$/, String(port)));
  if (out === cmd && defaultPort) out = out.replace(new RegExp(`\\b${defaultPort}\\b`, "g"), String(port));
  return `PORT=${port} ${out}`;
}
