import { z } from "zod";
import { IntentSchema } from "@forge/shared";

export const RequirementSchema = z.object({
  id: z.string(),
  /** The requirement as stated (or restated) in the meeting. */
  text: z.string(),
  /** "Som <roll> vill jag …" / "As a <role>, I want …". */
  userStory: z.string(),
  priority: z.enum(["must", "should", "could"]),
  /** Speaker who raised it, when known. */
  source: z.string().optional(),
});
export type Requirement = z.infer<typeof RequirementSchema>;

export const ActionItemSchema = z.object({
  text: z.string(),
  owner: z.string().optional(),
  due: z.string().optional(),
});
export type ActionItem = z.infer<typeof ActionItemSchema>;

export const ExtractionSchema = z.object({
  summary: z.string(),
  decisions: z.array(z.string()),
  requirements: z.array(RequirementSchema),
  openQuestions: z.array(z.string()),
  actionItems: z.array(ActionItemSchema),
  /** "mock-rules" when produced by the offline rule-based handler. */
  generator: z.string().optional(),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

export const EntityHintSchema = z.object({
  name: z.string(),
  fields: z.array(z.string()),
  relations: z.array(z.string()),
});
export type EntityHint = z.infer<typeof EntityHintSchema>;

export const MeetingSpecSchema = z.object({
  title: z.string(),
  language: z.string(),
  goals: z.array(z.string()),
  userStories: z.array(z.string()),
  entities: z.array(EntityHintSchema),
  screens: z.array(z.string()),
  integrations: z.array(z.string()),
  suggestedIntents: z.array(IntentSchema),
  acceptanceCriteria: z.array(z.string()),
  openQuestions: z.array(z.string()),
  generator: z.string().optional(),
});
export type MeetingSpec = z.infer<typeof MeetingSpecSchema>;
