import { z } from "zod";
import { ForgeError, newId, nullSink, type EventSink, type UsageSink } from "@forge/shared";
import { MeteredLLM, getModels, structured, type LLMProvider } from "@forge/llm";
import { fingerprint, normalizeMessage, parseStack, type StackFrame } from "./fingerprint.js";

/** One error event as sent by the kit's observability reporter (Sentry-like field names). */
export const ErrorEventSchema = z.object({
  type: z.string().max(200).default("Error"),
  message: z.string().min(1).max(4000),
  stack: z.string().max(20_000).optional(),
  url: z.string().max(2000).optional(),
  release: z.string().max(100).optional(),
  environment: z.string().max(50).default("production"),
  runtime: z.enum(["browser", "server", "edge", "mobile", "python"]).optional(),
  timestamp: z.string().datetime().optional(),
  tags: z.record(z.string().max(200)).optional(),
  /** Client-provided grouping override. */
  fingerprint: z.array(z.string().max(200)).max(10).optional(),
});
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;
export type ErrorEventInput = z.input<typeof ErrorEventSchema>;

export interface ErrorGroup {
  id: string;
  projectId: string;
  fingerprint: string;
  type: string;
  title: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  frames: StackFrame[];
  /** Most recent events (max 5). */
  samples: ErrorEvent[];
  status: "open" | "resolved" | "ignored";
}

export const FixPatchSchema = z.object({
  path: z.string().min(1),
  /** Exact text to find (must occur once). */
  search: z.string().min(1),
  replace: z.string(),
});
export const SuggestedFixBodySchema = z.object({
  summary: z.string().min(1).max(500),
  rootCause: z.string().max(4000),
  patches: z.array(FixPatchSchema).max(20),
  confidence: z.number().min(0).max(1),
});

export interface SuggestedFix extends z.infer<typeof SuggestedFixBodySchema> {
  id: string;
  groupId: string;
  projectId: string;
  status: "pending_approval" | "approved" | "rejected" | "applied";
  model: string;
  /** True when produced by the rule-based mock LLM. */
  isMock: boolean;
  createdAt: string;
  decidedBy?: string;
  appliedAt?: string;
}

export interface ErrorStore {
  getGroupByFingerprint(projectId: string, fp: string): Promise<ErrorGroup | null>;
  getGroup(id: string): Promise<ErrorGroup | null>;
  saveGroup(g: ErrorGroup): Promise<void>;
  listGroups(projectId: string): Promise<ErrorGroup[]>;
  saveFix(f: SuggestedFix): Promise<void>;
  getFix(id: string): Promise<SuggestedFix | null>;
}

export class MemoryErrorStore implements ErrorStore {
  private readonly groups = new Map<string, ErrorGroup>();
  private readonly fixes = new Map<string, SuggestedFix>();
  async getGroupByFingerprint(projectId: string, fp: string) {
    return [...this.groups.values()].find((g) => g.projectId === projectId && g.fingerprint === fp) ?? null;
  }
  async getGroup(id: string) {
    return this.groups.get(id) ?? null;
  }
  async saveGroup(g: ErrorGroup) {
    this.groups.set(g.id, g);
  }
  async listGroups(projectId: string) {
    return [...this.groups.values()].filter((g) => g.projectId === projectId).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  }
  async saveFix(f: SuggestedFix) {
    this.fixes.set(f.id, f);
  }
  async getFix(id: string) {
    return this.fixes.get(id) ?? null;
  }
}

export interface ProjectFiles {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
}

export interface ErrorIngestOptions {
  store?: ErrorStore;
  llm?: LLMProvider;
  usage?: UsageSink;
  events?: EventSink;
  model?: string;
}

const SYSTEM = `You are a senior engineer triaging a production error in a generated web/mobile app.
Given the error, its stack frames and the source lines around each in-app frame, explain the root cause
and propose the smallest safe fix as exact search/replace patches. Each "search" must be copied verbatim
from the provided source and occur exactly once in that file. Prefer guarding against bad data over
changing behaviour. If you are unsure, return no patches and a low confidence.
JSON shape: {"summary": string, "rootCause": string, "patches": [{"path": string, "search": string, "replace": string}], "confidence": number 0..1}`;

/**
 * Production feedback loop: groups error events by fingerprint, and on request asks an LLM
 * (purpose "appkit.suggest_fix") for a fix. A fix is only a suggestion: it must be approved by a
 * user before `applyFix` will touch any file.
 */
export class ErrorIngest {
  readonly store: ErrorStore;
  private readonly llm?: LLMProvider;
  private readonly usage?: UsageSink;
  private readonly events: EventSink;
  private readonly model?: string;

  constructor(opts: ErrorIngestOptions = {}) {
    this.store = opts.store ?? new MemoryErrorStore();
    this.llm = opts.llm;
    this.usage = opts.usage;
    this.events = opts.events ?? nullSink;
    this.model = opts.model;
  }

  async ingest(projectId: string, raw: ErrorEventInput): Promise<{ group: ErrorGroup; isNew: boolean }> {
    const e = ErrorEventSchema.parse(raw);
    const at = e.timestamp ?? new Date().toISOString();
    const fp = fingerprint(e);
    const existing = await this.store.getGroupByFingerprint(projectId, fp);
    if (existing) {
      const g: ErrorGroup = {
        ...existing,
        count: existing.count + 1,
        lastSeen: at > existing.lastSeen ? at : existing.lastSeen,
        samples: [...existing.samples, e].slice(-5),
        status: existing.status === "resolved" ? "open" : existing.status,
      };
      await this.store.saveGroup(g);
      return { group: g, isNew: false };
    }
    const g: ErrorGroup = {
      id: newId("errgrp"),
      projectId,
      fingerprint: fp,
      type: e.type,
      title: `${e.type}: ${normalizeMessage(e.message)}`.slice(0, 300),
      count: 1,
      firstSeen: at,
      lastSeen: at,
      frames: parseStack(e.stack),
      samples: [e],
      status: "open",
    };
    await this.store.saveGroup(g);
    return { group: g, isNew: true };
  }

  listGroups(projectId: string): Promise<ErrorGroup[]> {
    return this.store.listGroups(projectId);
  }

  async setStatus(groupId: string, status: ErrorGroup["status"]): Promise<ErrorGroup> {
    const g = await this.store.getGroup(groupId);
    if (!g) throw new ForgeError("NOT_FOUND", `Error group ${groupId} not found`);
    const next = { ...g, status };
    await this.store.saveGroup(next);
    return next;
  }

  /** Ask the LLM for a fix. Source lines around in-app frames are read through `files` when given. */
  async suggestFix(groupId: string, files?: Pick<ProjectFiles, "readFile">): Promise<SuggestedFix> {
    if (!this.llm) throw new ForgeError("BAD_INPUT", "ErrorIngest needs an llm to suggest fixes");
    const g = await this.store.getGroup(groupId);
    if (!g) throw new ForgeError("NOT_FOUND", `Error group ${groupId} not found`);
    const sample = g.samples[g.samples.length - 1] as ErrorEvent;
    const sources: Array<{ path: string; line: number; code: string; context: string }> = [];
    if (files) {
      for (const f of g.frames.filter((x) => x.inApp && x.line).slice(0, 5)) {
        const text = await files.readFile(f.file);
        if (text === null) continue;
        const lines = text.split("\n");
        const i = (f.line as number) - 1;
        if (i < 0 || i >= lines.length) continue;
        const from = Math.max(0, i - 8);
        const context = lines
          .slice(from, Math.min(lines.length, i + 9))
          .map((l, k) => `${from + k + 1}${from + k === i ? ">" : " "} ${l}`)
          .join("\n");
        sources.push({ path: f.file, line: f.line as number, code: lines[i] as string, context });
      }
    }
    const llm = this.usage ? new MeteredLLM(this.llm, this.usage, { projectId: g.projectId }) : this.llm;
    const context = { error: { type: g.type, message: sample.message, stack: sample.stack?.slice(0, 6000), occurrences: g.count, url: sample.url, runtime: sample.runtime }, frames: g.frames.slice(0, 10), sources };
    const { value, responses } = await structured(
      llm,
      {
        purpose: "appkit.suggest_fix",
        model: this.model ?? getModels().builder,
        system: SYSTEM,
        messages: [{ role: "user", content: `CONTEXT:\n${JSON.stringify(context, null, 2)}` }],
        maxTokens: 4000,
      },
      SuggestedFixBodySchema,
    );
    // Only keep patches that target files we showed the model.
    const allowed = new Set(sources.map((s) => s.path));
    const fix: SuggestedFix = {
      ...value,
      patches: value.patches.filter((p) => allowed.has(p.path)),
      id: newId("fix"),
      groupId,
      projectId: g.projectId,
      status: "pending_approval",
      model: responses[responses.length - 1]?.model ?? "unknown",
      isMock: llm.isMock,
      createdAt: new Date().toISOString(),
    };
    await this.store.saveFix(fix);
    this.events.emit({ type: "approval.required", projectId: g.projectId, approvalId: fix.id, action: "appkit.apply_fix", details: { groupId, summary: fix.summary, patches: fix.patches.length, confidence: fix.confidence, isMock: fix.isMock } });
    return fix;
  }

  private async decide(fixId: string, status: "approved" | "rejected", by: string): Promise<SuggestedFix> {
    const f = await this.store.getFix(fixId);
    if (!f) throw new ForgeError("NOT_FOUND", `Fix ${fixId} not found`);
    if (f.status !== "pending_approval") throw new ForgeError("BAD_INPUT", `Fix ${fixId} is ${f.status}`);
    const next = { ...f, status, decidedBy: by };
    await this.store.saveFix(next);
    return next;
  }

  approveFix(fixId: string, userId: string): Promise<SuggestedFix> {
    return this.decide(fixId, "approved", userId);
  }

  rejectFix(fixId: string, userId: string): Promise<SuggestedFix> {
    return this.decide(fixId, "rejected", userId);
  }

  /** Apply an approved fix. All patches are checked before any file is written (all or nothing). */
  async applyFix(fixId: string, files: ProjectFiles): Promise<{ changed: string[] }> {
    const f = await this.store.getFix(fixId);
    if (!f) throw new ForgeError("NOT_FOUND", `Fix ${fixId} not found`);
    if (f.status !== "approved") throw new ForgeError("APPROVAL_REQUIRED", `Fix ${fixId} must be approved by a user before it is applied (status: ${f.status})`);
    const next = new Map<string, string>();
    for (const p of f.patches) {
      const current = next.get(p.path) ?? (await files.readFile(p.path));
      if (current === null) throw new ForgeError("NOT_FOUND", `File ${p.path} not found`);
      const first = current.indexOf(p.search);
      if (first === -1 || current.indexOf(p.search, first + 1) !== -1) throw new ForgeError("GATE_FAILED", `Patch for ${p.path} does not match exactly once; the file changed since the fix was suggested`);
      next.set(p.path, current.slice(0, first) + p.replace + current.slice(first + p.search.length));
    }
    for (const [path, content] of next) await files.writeFile(path, content);
    await this.store.saveFix({ ...f, status: "applied", appliedAt: new Date().toISOString() });
    return { changed: [...next.keys()] };
  }
}
