import { structured, getModels, type LLMProvider } from "@forge/llm";
import type { Intent } from "@forge/shared";
import { SpecSchema, type Spec } from "./spec.js";

export const PLANNER_SYSTEM = `You are Forge's planner. Turn the user's request into a precise build spec.
Rules:
- kind: app | website | mobile | backend (pick the primary deliverable).
- userStories: concrete "As a <role> I can <action> so that <value>" items.
- entities: the data model. Field names camelCase, entity names PascalCase. ownerScoped=true when rows belong to the signed-in user.
- screens: routes/screens with purpose; mark marketing/legal pages public.
- auth: true if users sign in.
- acceptanceTests: 3-10 Given/When/Then scenarios that map 1:1 to Playwright tests and prove the core user journey works.
- tasks: small, dependency-ordered implementation steps.
- designNotes: the feel the design engine should aim for.
Prefer the simplest robust design. Never invent integrations the user did not ask for.`;

export interface PlanInput {
  prompt: string;
  intents: Intent[];
  kind: Spec["kind"];
  templateHint?: string;
  /** Extra context when re-planning after repeated failures. */
  failureContext?: string;
}

export async function plan(llm: LLMProvider, input: PlanInput): Promise<{ spec: Spec; costUsd: number }> {
  const user = [
    `Request:\n${input.prompt}`,
    `Detected intents: ${input.intents.map((i) => `${i.kind}${i.hint ? `(${i.hint})` : ""}`).join(", ") || "none"}`,
    `Primary kind: ${input.kind}${input.templateHint ? `; template: ${input.templateHint}` : ""}`,
    input.failureContext ? `Previous attempt failed repeatedly:\n${input.failureContext}\nProduce a simpler plan that avoids this failure.` : "",
    `Return JSON matching: { title, summary, kind, template?, userStories[], entities[{name, description, fields[{name,type,required,enumValues?,references?}], ownerScoped}], screens[{path,name,purpose,public}], integrations[], auth, acceptanceTests[{id,title,given,when,then}], designNotes, tasks[{id,title,dependsOn[]}] }`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const { value, responses } = await structured(
    llm,
    { purpose: "agent.plan", model: getModels().planner, system: PLANNER_SYSTEM, messages: [{ role: "user", content: user }], maxTokens: 16000, cache: true, effort: "high" },
    SpecSchema,
  );
  return { spec: { ...value, template: value.template ?? input.templateHint }, costUsd: responses.reduce((a, r) => a + r.costUsd, 0) };
}
