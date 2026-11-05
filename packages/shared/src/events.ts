import { z } from "zod";
import { IntentSchema } from "./intents.js";

const base = {
  id: z.string(),
  projectId: z.string(),
  taskId: z.string().optional(),
  at: z.string(),
};

/** Every event the agent/media/meeting pipelines stream to clients over the WebSocket gateway. */
export const ForgeEventSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("intent.classified"), intents: z.array(IntentSchema) }),
  z.object({
    ...base,
    type: z.literal("cost.estimate"),
    lowUsd: z.number(),
    highUsd: z.number(),
    breakdown: z.array(z.object({ label: z.string(), usd: z.number() })),
  }),
  z.object({ ...base, type: z.literal("clarify.question"), question: z.string(), options: z.array(z.string()).optional() }),
  z.object({ ...base, type: z.literal("phase.started"), phase: z.enum(["plan", "design", "build", "verify", "review", "finish", "media", "slides", "agent", "meeting"]) }),
  z.object({ ...base, type: z.literal("phase.completed"), phase: z.string(), durationMs: z.number() }),
  z.object({ ...base, type: z.literal("plan.ready"), spec: z.unknown(), requiresApproval: z.boolean() }),
  z.object({ ...base, type: z.literal("design.directions"), directions: z.array(z.unknown()) }),
  z.object({ ...base, type: z.literal("message.delta"), text: z.string() }),
  z.object({ ...base, type: z.literal("message"), role: z.enum(["assistant", "system"]), text: z.string() }),
  z.object({ ...base, type: z.literal("tool.call"), tool: z.string(), input: z.unknown(), callId: z.string() }),
  z.object({ ...base, type: z.literal("tool.result"), callId: z.string(), ok: z.boolean(), summary: z.string() }),
  z.object({ ...base, type: z.literal("file.changed"), path: z.string(), change: z.enum(["created", "modified", "deleted"]) }),
  z.object({ ...base, type: z.literal("gate.result"), gate: z.string(), passed: z.boolean(), details: z.string(), fix: z.string().optional() }),
  z.object({ ...base, type: z.literal("design.score"), score: z.number(), viewport: z.number().optional(), notes: z.string() }),
  z.object({ ...base, type: z.literal("screenshot"), url: z.string(), viewport: z.number() }),
  z.object({ ...base, type: z.literal("checkpoint.created"), checkpointId: z.string(), commit: z.string(), label: z.string() }),
  z.object({ ...base, type: z.literal("job.progress"), jobId: z.string(), progress: z.number().min(0).max(1), label: z.string().optional() }),
  z.object({ ...base, type: z.literal("artifact.ready"), artifactId: z.string(), kind: z.string(), url: z.string() }),
  z.object({ ...base, type: z.literal("approval.required"), approvalId: z.string(), action: z.string(), details: z.unknown() }),
  z.object({ ...base, type: z.literal("usage"), costUsd: z.number(), tokensIn: z.number(), tokensOut: z.number() }),
  z.object({ ...base, type: z.literal("task.completed"), summary: z.string(), chargedUsd: z.number() }),
  z.object({ ...base, type: z.literal("task.failed"), reason: z.string(), charged: z.boolean(), blockedOn: z.string().optional() }),
  z.object({ ...base, type: z.literal("presence"), userId: z.string(), name: z.string(), cursor: z.unknown().optional() }),
]);
export type ForgeEvent = z.infer<typeof ForgeEventSchema>;
export type ForgeEventType = ForgeEvent["type"];

/** Distributive Omit so callers can build events without id/at. */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
export type ForgeEventInput = DistributiveOmit<ForgeEvent, "id" | "at">;

export interface EventSink {
  emit(e: ForgeEventInput): void;
}

/** In-process event bus used by workers and tests; the API gateway bridges it to Redis pub/sub. */
export class EventBus implements EventSink {
  private listeners = new Set<(e: ForgeEvent) => void>();
  private counter = 0;
  readonly history: ForgeEvent[] = [];
  constructor(private readonly keepHistory = true) {}

  emit(e: ForgeEventInput): void {
    const full = { ...e, id: `evt_${Date.now().toString(36)}_${(this.counter++).toString(36)}`, at: new Date().toISOString() } as ForgeEvent;
    if (this.keepHistory) this.history.push(full);
    for (const l of this.listeners) l(full);
  }
  subscribe(fn: (e: ForgeEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  ofType<T extends ForgeEventType>(type: T): Extract<ForgeEvent, { type: T }>[] {
    return this.history.filter((e): e is Extract<ForgeEvent, { type: T }> => e.type === type);
  }
}

export const nullSink: EventSink = { emit: () => undefined };
