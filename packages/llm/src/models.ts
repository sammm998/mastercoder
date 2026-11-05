export interface ModelConfig {
  planner: string;
  builder: string;
  fast: string;
  vision: string;
}

/** Models are configurable by env (MODEL_PLANNER / MODEL_BUILDER / MODEL_FAST / MODEL_VISION_REVIEW). */
export function getModels(): ModelConfig {
  return {
    planner: process.env.MODEL_PLANNER || "claude-opus-5-5",
    builder: process.env.MODEL_BUILDER || "claude-sonnet-5-5",
    fast: process.env.MODEL_FAST || "claude-haiku-5-5",
    vision: process.env.MODEL_VISION_REVIEW || "claude-sonnet-5-5",
  };
}

export type StepComplexity = "trivial" | "normal" | "complex";

export function modelForComplexity(c: StepComplexity, m: ModelConfig = getModels()): string {
  return c === "trivial" ? m.fast : c === "complex" ? m.planner : m.builder;
}
