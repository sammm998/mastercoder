import sharp from "sharp";
import { ForgeError, isForgeError, newId, type CostEstimate, type EventSink, type ObjectStore, type UsageSink } from "@forge/shared";
import type { LLMProvider } from "@forge/llm";
import { MediaJobSchema, jobImages, jobPrompt, runOnProvider, type MediaJob, type MediaProvider, type MediaResult } from "./types.js";
import { moderate } from "./moderation/index.js";
import { itemBytes } from "./logo.js";
import { extForMime } from "./util.js";

export interface Artifact {
  id: string;
  kind: "image" | "video";
  storageKey: string;
  mimeType: string;
  meta: Record<string, unknown>;
  costUsd: number;
}

export interface MediaJobDeps {
  provider: MediaProvider;
  store: ObjectStore;
  sink: UsageSink;
  events: EventSink;
  /** Optional LLM second-opinion moderation (purpose "media.moderate"). */
  moderationLlm?: LLMProvider;
  moderationModel?: string;
}

export interface MediaJobContext {
  projectId: string;
  taskId?: string;
  workspaceId?: string;
  /** Defaults to a fresh `job_…` id. */
  jobId?: string;
}

function parseJob(job: unknown): MediaJob {
  const r = MediaJobSchema.safeParse(job);
  if (!r.success) throw new ForgeError("BAD_INPUT", `Invalid media job: ${r.error.message}`);
  return r.data;
}

/** Runs media jobs end-to-end: moderation → provider → object storage → usage + events. */
export class MediaJobService {
  constructor(private readonly deps: MediaJobDeps) {}

  estimate(job: MediaJob): CostEstimate {
    return this.deps.provider.estimate(parseJob(job));
  }

  async run(input: MediaJob, ctx: MediaJobContext): Promise<Artifact[]> {
    const job = parseJob(input);
    const { provider, store, sink, events } = this.deps;
    const jobId = ctx.jobId ?? newId("job");
    const base = { projectId: ctx.projectId, taskId: ctx.taskId };
    const progress = (p: number, label: string) => events.emit({ ...base, type: "job.progress", jobId, progress: Math.max(0, Math.min(1, p)), label });

    progress(0, "moderating");
    const verdict = await moderate({ prompt: jobPrompt(job), images: jobImages(job) }, { llm: this.deps.moderationLlm, model: this.deps.moderationModel });
    if (!verdict.allowed) {
      events.emit({ ...base, type: "task.failed", reason: `Blocked by moderation: ${verdict.reason}`, charged: false, blockedOn: verdict.category });
      throw new ForgeError("MODERATION_BLOCKED", verdict.reason, { category: verdict.category, source: verdict.source, matched: verdict.matched, jobId });
    }
    progress(0.05, "moderation passed");

    let result: MediaResult;
    try {
      result = await runOnProvider(provider, job, { onProgress: (p, label) => progress(0.05 + 0.75 * p, label ?? "generating") });
    } catch (e) {
      if (isForgeError(e)) throw e;
      throw new ForgeError("PROVIDER_ERROR", `${provider.name} ${job.type} failed: ${(e as Error).message}`, { jobId });
    }
    if (result.items.length === 0) throw new ForgeError("PROVIDER_ERROR", `${provider.name} returned no media`, { jobId });

    const kind: Artifact["kind"] = job.type === "text-to-video" || job.type === "image-to-video" ? "video" : "image";
    const perItemCost = result.costUsd / result.items.length;
    const artifacts: Artifact[] = [];
    for (const [i, item] of result.items.entries()) {
      const bytes = await itemBytes(item);
      let { width, height } = item;
      if (kind === "image" && (width === undefined || height === undefined)) {
        const m = await sharp(bytes).metadata();
        width ??= m.width;
        height ??= m.height;
      }
      const id = newId("art");
      const storageKey = `projects/${ctx.projectId}/media/${id}.${extForMime(item.mimeType)}`;
      await store.put(storageKey, bytes, { contentType: item.mimeType });
      artifacts.push({
        id,
        kind,
        storageKey,
        mimeType: item.mimeType,
        costUsd: perItemCost,
        meta: {
          ...item.meta,
          jobId,
          jobType: job.type,
          provider: result.provider,
          model: result.model,
          mock: provider.isMock,
          prompt: jobPrompt(job) || undefined,
          width,
          height,
          durationSec: item.durationSec,
          sizeBytes: bytes.byteLength,
          moderation: verdict.source,
        },
      });
      progress(0.8 + (0.15 * (i + 1)) / result.items.length, `stored ${i + 1}/${result.items.length}`);
    }

    const seconds = result.items.reduce((a, it) => a + (it.durationSec ?? 0), 0);
    await sink.record({
      kind: kind === "video" ? "media_seconds" : "image_count",
      quantity: kind === "video" ? seconds : result.items.length,
      costUsd: result.costUsd,
      provider: result.provider,
      model: result.model,
      projectId: ctx.projectId,
      taskId: ctx.taskId,
      workspaceId: ctx.workspaceId,
    });

    for (const a of artifacts) {
      events.emit({ ...base, type: "artifact.ready", artifactId: a.id, kind: a.kind, url: await store.url(a.storageKey) });
    }
    progress(1, "done");
    return artifacts;
  }
}
