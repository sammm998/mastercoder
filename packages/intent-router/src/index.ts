import "./mock-llm.js";

export { classify, CLASSIFY_PURPOSE, LlmClassificationSchema, type ClassifyOptions, type ClassifyResult, type LlmClassification } from "./classify.js";
export { classifyByRules, detectLanguage, kindLabel, type Attachment, type Language, type Quantities, type RuleClassification, type AmbiguityReason } from "./rules.js";

import { estimateTask, type EstimateInput } from "@forge/billing";
import type { CostEstimate } from "@forge/shared";
/** Package-level estimate() (contract): delegates to @forge/billing estimateTask. */
export function estimate(input: EstimateInput): CostEstimate {
  return estimateTask(input);
}
