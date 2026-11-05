import { z } from "zod";
import { IntentSchema, PromptSource } from "./intents.js";

/** BullMQ queue names shared by apps/api (producer) and apps/agent-worker (consumer). */
export const QUEUES = {
  build: "forge-build",
  media: "forge-media",
  slides: "forge-slides",
  transcription: "forge-transcription",
  meetingBot: "forge-meeting-bot",
  agentRun: "forge-agent-run",
  deploy: "forge-deploy",
  scan: "forge-scan",
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const BuildJobSchema = z.object({
  taskId: z.string(),
  projectId: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
  prompt: z.string(),
  source: PromptSource,
  intents: z.array(IntentSchema),
  planMode: z.boolean().default(false),
  approvedSpec: z.unknown().optional(),
});
export type BuildJob = z.infer<typeof BuildJobSchema>;

export const MediaJobSchema = z.object({
  taskId: z.string(),
  projectId: z.string(),
  workspaceId: z.string(),
  kind: z.enum(["image", "image-set", "logo", "video", "remotion"]),
  prompt: z.string(),
  options: z.record(z.unknown()).default({}),
});
export type MediaJobPayload = z.infer<typeof MediaJobSchema>;

export const SlidesJobSchema = z.object({
  taskId: z.string(),
  projectId: z.string(),
  workspaceId: z.string(),
  kind: z.enum(["deck", "document"]),
  prompt: z.string(),
  slideCount: z.number().int().min(1).max(60).optional(),
});
export type SlidesJobPayload = z.infer<typeof SlidesJobSchema>;

export const TranscriptionJobSchema = z.object({
  meetingId: z.string(),
  workspaceId: z.string(),
  audioKey: z.string().optional(),
  language: z.string().default("sv"),
  /** Text transcript (uploaded or from a bot vendor) instead of audio. */
  transcript: z.string().max(400_000).optional(),
});
export type TranscriptionJob = z.infer<typeof TranscriptionJobSchema>;

export const MeetingBotJobSchema = z.object({
  meetingId: z.string(),
  workspaceId: z.string(),
  action: z.enum(["join", "leave", "poll"]),
  meetingUrl: z.string().url().optional(),
  language: z.string().default("sv"),
});
export type MeetingBotJob = z.infer<typeof MeetingBotJobSchema>;

export const AgentRunJobSchema = z.object({
  agentId: z.string(),
  workspaceId: z.string(),
  trigger: z.enum(["cron", "webhook", "email", "chat", "manual", "test"]),
  input: z.unknown().optional(),
  resumeRunId: z.string().optional(),
});
export type AgentRunJob = z.infer<typeof AgentRunJobSchema>;

export const DeployJobSchema = z.object({
  projectId: z.string(),
  workspaceId: z.string(),
  checkpointId: z.string().optional(),
  branch: z.string().default("main"),
  rollbackTo: z.string().optional(),
});
export type DeployJob = z.infer<typeof DeployJobSchema>;

export const ScanJobSchema = z.object({ deploymentId: z.string(), projectId: z.string(), url: z.string() });
export type ScanJob = z.infer<typeof ScanJobSchema>;

/** Redis pub/sub channel for a project's event stream. */
export const eventChannel = (projectId: string) => `forge:events:${projectId}`;
