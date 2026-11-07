import type { Spec } from "./spec.js";
import type { TemplateManifestLike } from "./ports.js";

/** Stable system prompt (prompt-cached). Volatile context goes into user turns. */
export const BUILDER_SYSTEM = `You are Forge's builder. You implement a spec inside a sandboxed project using tools.

Working rules:
- Make small, targeted edits (edit_file) instead of rewriting large files; write_file for new files.
- Read a file before editing it. Never load the whole repository; use the repository map and search_code.
- Keep the project's existing framework and template. Never migrate to another framework (e.g. Vite → Astro or Next) unless the user explicitly asks; build what the spec needs inside the current stack.
- Every endpoint validates input (zod / pydantic). Every non-public route checks authentication.
- Endpoints that are public by design (contact/newsletter forms, webhooks, health checks) get a \`// forge:public\` comment on the line above the handler and their path in forge.json "publicRoutes".
- When adding a dependency use its current major version (npm install <pkg>@latest); never pin old majors with known vulnerabilities.
- forge.json "test" runs in Node without a browser (vitest or node:test). Browser tests belong only in the e2e command.
- Every database table has row-level access rules (ENABLE ROW LEVEL SECURITY + policies scoped to the owner).
- Secrets stay server-side: never reference secret env vars in client code.
- Use the design tokens (CSS variables in tokens.css) for colors, type, spacing and motion. Honour prefers-reduced-motion.
- Websites: build the design concept faithfully and make the site unique to this business. The composed scaffold supplies tokens, components and motion patterns (src/patterns) to reuse; its default section order and layout are placeholders, not the design.
- Keep the art direction's motion (scroll reveals, parallax, hover/magnetic effects in src/patterns). Never remove or flatten animations to fix a check; optimise them instead.
- Write tests for the acceptance criteria. Run run_tests (and run_e2e when available) before finishing.
- Never present hardcoded demo data as real functionality. Seed data must be clearly labelled as sample data.
- When done, reply with a short summary of what you built and anything you assumed. Do not call tools after that.`;

export function buildPrompt(spec: Spec, template: string, manifest: TemplateManifestLike | null, direction: string, followUp?: string, history?: string, request?: string): string {
  return [
    // The plan is a summary; the user's own words carry the details (file paths, data formats, exact copy).
    request && !followUp ? `## The user's request (every requirement here must be met)\n${request.slice(0, 12_000)}\n` : "",
    history ? `## Earlier in this project\n${history}\n` : "",
    followUp ? `## Follow-up request\n${followUp}\nThe project already exists in the sandbox: read the relevant files first and change them in place. Do not start over or re-scaffold.\n` : "",
    `## Spec\n${JSON.stringify(spec, null, 2)}`,
    `## Project\nTemplate: ${template}${manifest ? `\nCommands: install=\`${manifest.install}\` dev=\`${manifest.dev}\` test=\`${manifest.test ?? "-"}\` typecheck=\`${manifest.typecheck ?? "-"}\` lint=\`${manifest.lint ?? "-"}\` e2e=\`${manifest.e2e ?? "-"}\`` : ""}`,
    direction ? `Art direction: ${direction} (tokens.css is already written — use its variables).` : "",
    `Implement the spec now, task by task. Then run the tests.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function fixPrompt(gateSummary: string): string {
  return `The quality gates failed. Fix the root causes (not the symptoms), then re-run the relevant checks.\n\n${gateSummary}`;
}

export function strategyPrompt(strategy: "reread_files" | "search_docs" | "replan", failure: string, docs: string, spec: Spec): string {
  if (strategy === "reread_files") {
    return `The same error keeps happening. Stop guessing: re-read every file involved in this error (and the files they import) with read_file before changing anything, then fix it.\n\nError:\n${failure}`;
  }
  if (strategy === "search_docs") {
    return `The same error keeps happening. Here is relevant documentation; use web_search_docs for more if needed, then fix it.\n\n${docs || "(no docs found)"}\n\nError:\n${failure}`;
  }
  return `The plan was revised to avoid a recurring failure. Re-align the implementation with the new spec, simplifying where needed.\n\n## New spec\n${JSON.stringify(spec, null, 2)}\n\nPrevious error:\n${failure}`;
}
