import { getModels, modelForComplexity, type ModelConfig, type StepComplexity } from "@forge/llm";

export interface StepDescriptor {
  phase: "plan" | "design" | "build" | "fix" | "review" | "summary";
  /** Number of files the step is expected to touch. */
  fileCount?: number;
  /** Consecutive failures on this task so far. */
  failures?: number;
  /** Free-text description used for keyword heuristics. */
  description?: string;
}

const TRIVIAL = /\b(rename|typo|copy|text change|color|colour|spacing|padding|margin|label|translate|översätt|byt namn)\b/i;
const COMPLEX = /\b(architecture|refactor|migrat|security|auth|payment|realtime|concurren|race|performance|schema)\b/i;

/**
 * Pick model tier per step: trivial → MODEL_FAST, normal → MODEL_BUILDER, complex → MODEL_PLANNER.
 * Planning and review always use the planner tier; repeated failures escalate.
 */
export function classifyStep(s: StepDescriptor): StepComplexity {
  if (s.phase === "plan" || s.phase === "review") return "complex";
  if (s.phase === "summary") return "trivial";
  if ((s.failures ?? 0) >= 3) return "complex";
  const d = s.description ?? "";
  if (COMPLEX.test(d) || (s.fileCount ?? 0) > 12) return "complex";
  if (TRIVIAL.test(d) && (s.fileCount ?? 1) <= 2) return "trivial";
  return "normal";
}

export function pickModel(s: StepDescriptor, models: ModelConfig = getModels()): { model: string; complexity: StepComplexity } {
  const complexity = classifyStep(s);
  return { model: modelForComplexity(complexity, models), complexity };
}
