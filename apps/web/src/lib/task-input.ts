import type { ComposerMode } from "@/components/PromptComposer";

/**
 * Input for `task.create`. `mode` ("build" | "plan" | "chat") is the current API contract; `planMode` is
 * still sent for older API builds (they ignore the unknown `mode` key — zod strips it).
 */
export function taskCreateInput(projectId: string, prompt: string, s: { source: "typed" | "voice"; mode: ComposerMode }) {
  const input = { projectId, prompt, source: s.source, planMode: s.mode === "plan", mode: s.mode };
  return input;
}
