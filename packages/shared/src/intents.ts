import { z } from "zod";

export const IntentKind = z.enum([
  "app",
  "website",
  "mobile",
  "backend",
  "image",
  "video",
  "slides",
  "document",
  "agent",
  "integration",
  "question",
]);
export type IntentKind = z.infer<typeof IntentKind>;

export const PromptSource = z.enum(["typed", "voice", "meeting", "api"]);
export type PromptSource = z.infer<typeof PromptSource>;

export const IntentSchema = z.object({
  kind: IntentKind,
  confidence: z.number().min(0).max(1),
  /** Short restatement of the part of the prompt this intent covers. */
  summary: z.string(),
  /** Template or sub-type hint, e.g. "nextjs", "expo", "fastapi", "remotion", "text-to-video". */
  hint: z.string().optional(),
});
export type Intent = z.infer<typeof IntentSchema>;
