import type { CostEstimate, Intent, PromptSource } from "@forge/shared";
import type { DomainServices } from "./deps.js";

/** Contract the API needs from @forge/intent-router (wired in src/wiring.ts). */
export interface IntentClassifier {
  classify(
    prompt: string,
    opts: { source: PromptSource },
  ): Promise<{ intents: Intent[]; needsClarification: boolean; question?: string; options?: string[]; estimate: CostEstimate; language: string }>;
}

/** Contract the API needs from @forge/billing. */
export interface SpendChecker {
  check(scope: { userId?: string; workspaceId?: string; agentId?: string }, projectedUsd: number): Promise<void>;
}

export function getService<T>(services: DomainServices, name: string): T | undefined {
  return services[name] as T | undefined;
}
