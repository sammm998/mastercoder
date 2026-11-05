import { z } from "zod";
import { structured, getModels, type LLMProvider } from "@forge/llm";
import type { Spec } from "./spec.js";

export const REVIEWER_SYSTEM = `You are Forge's code reviewer with fresh context. You see the spec and the files changed in this task.
Report only real problems that would make the result wrong, insecure or not match the spec:
missing user stories or screens, entities without persistence, routes without auth checks, unvalidated input,
secrets in client code, tables without row-level access rules, broken imports, fake/hardcoded data presented as real.
Do not nitpick style. approved=true only when there are no blocking issues.`;

export const ReviewSchema = z.object({
  approved: z.boolean(),
  issues: z.array(z.object({ file: z.string().optional(), problem: z.string(), fix: z.string() })).default([]),
});
export type Review = z.infer<typeof ReviewSchema>;

export async function review(llm: LLMProvider, spec: Spec, files: Array<{ path: string; content: string }>): Promise<{ review: Review; costUsd: number }> {
  const budget = 120_000;
  let used = 0;
  const parts: string[] = [];
  for (const f of files) {
    const body = f.content.length > 12_000 ? `${f.content.slice(0, 12_000)}\n…[truncated]` : f.content;
    if (used + body.length > budget) {
      parts.push(`### ${f.path}\n(omitted: review budget reached)`);
      continue;
    }
    used += body.length;
    parts.push(`### ${f.path}\n\`\`\`\n${body}\n\`\`\``);
  }
  const { value, responses } = await structured(
    llm,
    {
      purpose: "agent.review",
      model: getModels().planner,
      system: REVIEWER_SYSTEM,
      messages: [{ role: "user", content: `## Spec\n${JSON.stringify(spec, null, 2)}\n\n## Changed files\n${parts.join("\n\n")}\n\nReturn JSON { approved, issues[{file?, problem, fix}] }.` }],
      maxTokens: 8000,
      effort: "high",
    },
    ReviewSchema,
  );
  return { review: value, costUsd: responses.reduce((a, r) => a + r.costUsd, 0) };
}
