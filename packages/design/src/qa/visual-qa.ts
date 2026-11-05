import sharp from "sharp";
import { getModels, structured, type ContentBlock, type LLMProvider } from "@forge/llm";
import type { ArtDirection, Criterion, DesignBrief, Screenshot } from "../types.js";
import { checklistText } from "./checklist.js";
import { CriticResultSchema, overallScore, type PageMetrics } from "./critic-heuristic.js";
import { analyzePage, type HeuristicReport } from "./heuristic.js";
import { captureScreenshots } from "./screenshots.js";

export interface VisualQAContext {
  brief?: DesignBrief;
  direction?: ArtDirection;
  /** Browser-measured metrics from analyzePage(); required for the heuristic (mock) critic. */
  heuristics?: PageMetrics;
  threshold?: number;
  model?: string;
}

export interface VisualQAResult {
  score: number;
  criteria: Record<Criterion, number>;
  notes: string;
  passed: boolean;
  suggestions: string[];
  /** "llm" = vision model critique; "heuristic" = rule-based mapping of measured metrics. */
  critic: "llm" | "heuristic";
}

export const CRITIC_SYSTEM = `You are a design critic for award-level websites (Awwwards jury standard).
Score each criterion 1-10 with evidence from the screenshots, using this checklist:

${checklistText()}

Penalise template layouts (centred hero + three cards), default fonts, low contrast and layout shift.
For every criterion below 8 give a concrete CSS/layout/motion change in "suggestions".
Return JSON: {"criteria":{"hierarchy":n,"spacing":n,"contrast":n,"rhythm":n,"motion":n,"originality":n},"notes":"...","suggestions":["..."]}`;

/** Downscale a full-page PNG for a vision model (max 1000px wide, max 7800px tall). */
export async function prepareImage(png: Buffer, maxWidth = 1000, maxHeight = 7800): Promise<string> {
  const img = sharp(png);
  const meta = await img.metadata();
  const w = meta.width ?? maxWidth;
  const scale = Math.min(1, maxWidth / w);
  const resized = await img.resize({ width: Math.round(w * scale) }).png().toBuffer();
  const m2 = await sharp(resized).metadata();
  const out = (m2.height ?? 0) > maxHeight ? await sharp(resized).extract({ left: 0, top: 0, width: m2.width!, height: maxHeight }).png().toBuffer() : resized;
  return out.toString("base64");
}

/**
 * Score screenshots against the checklist (LLM purpose "design.critic", MODEL_VISION_REVIEW, image blocks).
 * With the mock provider the registered handler maps `ctx.heuristics` to scores and the result is labeled
 * `critic: "heuristic"`.
 */
export async function visualQA(llm: LLMProvider, shots: Screenshot[], ctx: VisualQAContext = {}): Promise<VisualQAResult> {
  const threshold = ctx.threshold ?? 8;
  const blocks: ContentBlock[] = [];
  for (const s of shots) {
    blocks.push({ type: "text", text: `Screenshot at ${s.viewport}px (full page, downscaled):` });
    blocks.push({ type: "image", mediaType: "image/png", data: await prepareImage(s.png) });
  }
  const context = [
    ctx.brief ? `<brief>${JSON.stringify(ctx.brief)}</brief>` : "",
    ctx.direction ? `<direction>${JSON.stringify({ name: ctx.direction.name, mood: ctx.direction.mood, motion: ctx.direction.motion.language, fonts: [ctx.direction.typography.display.family, ctx.direction.typography.body.family] })}</direction>` : "",
    ctx.heuristics ? `Browser-measured metrics (trust these over visual impressions for contrast/CLS):\n<heuristics>${JSON.stringify(ctx.heuristics)}</heuristics>` : "",
  ]
    .filter(Boolean)
    .join("\n");
  blocks.push({ type: "text", text: `${context}\nScore the page now.` });
  const { value } = await structured(
    llm,
    { purpose: "design.critic", model: ctx.model ?? getModels().vision, system: CRITIC_SYSTEM, messages: [{ role: "user", content: blocks }], maxTokens: 3000 },
    CriticResultSchema,
  );
  const parsed = CriticResultSchema.parse(value);
  const score = overallScore(parsed.criteria);
  return {
    score,
    criteria: parsed.criteria,
    notes: parsed.notes,
    suggestions: parsed.suggestions,
    passed: score >= threshold,
    critic: llm.isMock || parsed.critic === "heuristic" ? "heuristic" : "llm",
  };
}

export interface QARound {
  round: number;
  url: string;
  result: VisualQAResult;
  heuristics?: HeuristicReport;
}

export interface DesignQALoopOptions {
  /** Build (or rebuild) the site using feedback from the previous round; returns a preview URL. */
  build: (feedback: VisualQAResult | null, round: number) => Promise<string>;
  /** Defaults to captureScreenshots + analyzePage + visualQA(llm). */
  evaluate?: (url: string) => Promise<{ result: VisualQAResult; heuristics?: HeuristicReport }>;
  llm?: LLMProvider;
  ctx?: Omit<VisualQAContext, "heuristics">;
  threshold?: number;
  maxRounds?: number;
}

export interface DesignQALoopResult {
  passed: boolean;
  rounds: QARound[];
  best: QARound;
}

/** Build → screenshot → critique → rebuild with feedback, until score >= threshold or maxRounds. */
export async function designQALoop(opts: DesignQALoopOptions): Promise<DesignQALoopResult> {
  const threshold = opts.threshold ?? 8;
  const maxRounds = opts.maxRounds ?? 3;
  const evaluate =
    opts.evaluate ??
    (async (url: string) => {
      if (!opts.llm) throw new Error("designQALoop: provide `llm` or a custom `evaluate`");
      const heuristics = await analyzePage(url);
      const shots = await captureScreenshots(url);
      const result = await visualQA(opts.llm, shots, { ...opts.ctx, heuristics: heuristics.metrics, threshold });
      return { result, heuristics };
    });
  const rounds: QARound[] = [];
  let feedback: VisualQAResult | null = null;
  for (let round = 1; round <= maxRounds; round++) {
    const url = await opts.build(feedback, round);
    const { result, heuristics } = await evaluate(url);
    rounds.push({ round, url, result, ...(heuristics ? { heuristics } : {}) });
    if (result.score >= threshold) break;
    feedback = result;
  }
  const best = rounds.reduce((a, b) => (b.result.score > a.result.score ? b : a));
  return { passed: best.result.score >= threshold, rounds, best };
}
