/**
 * Offline mock builder for LLM purpose "agent.build": a rule-based, template-based code generator
 * (not a model). Registered in ../mock-llm.ts so LLM_PROVIDER=mock builds real, verified projects.
 */
export { mockBuildHandler, openApiPathOf } from "./handler.js";
export { generateProject, UnsupportedBuildError } from "./generate.js";
export { parseConversation, exitCodeOf, fileFromReadResult, type Conversation, type Round, type RoundKind } from "./conversation.js";
export { parseGateFailures, planAuthFix, addPublicMarker, addSessionCheck, rlsSqlFromFix, type GateFailure, type AuthPlan } from "./fixes.js";
export { improveContrast, contrast, ensureContrast } from "./design-fix.js";
export { detectRules, type DomainRules } from "./domain.js";
export { entityModels, type EntityModel, type FieldModel } from "./model.js";
export { HEADER as MOCK_BUILDER_HEADER } from "./names.js";
export type { GenerateContext, GeneratedProject } from "./types.js";
