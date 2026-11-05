import { z } from "zod";
import { ForgeError, type CostEstimate } from "@forge/shared";
import type {
  AspectRatio,
  CallOptions,
  EditImageInput,
  ImageToVideoInput,
  MediaItem,
  MediaJob,
  MediaProvider,
  MediaResult,
  RemoveBackgroundInput,
  TextToImageInput,
  TextToVideoInput,
  UpscaleInput,
} from "../types.js";
import { costForUnits, megapixels, priceFor } from "../pricing.js";
import { estimateFromTable } from "../estimate.js";
import { sleep } from "../util.js";
import { imageToUrl, readJson, requireKey, type FetchFn } from "./http.js";

export interface FalModels {
  imageFast: string;
  image: string;
  imagePro: string;
  edit: string;
  editMask: string;
  removeBackground: string;
  upscale: string;
  textToVideo: string;
  imageToVideo: string;
}

export const DEFAULT_FAL_MODELS: FalModels = {
  imageFast: "fal-ai/flux/schnell",
  image: "fal-ai/flux/dev",
  imagePro: "fal-ai/flux-pro/v1.1",
  edit: "fal-ai/flux-pro/kontext",
  editMask: "fal-ai/flux-pro/v1/fill",
  removeBackground: "fal-ai/bria/background/remove",
  upscale: "fal-ai/esrgan",
  textToVideo: "fal-ai/veo3.1/fast",
  imageToVideo: "fal-ai/kling-video/v2.5-turbo/pro/image-to-video",
};

export interface FalOptions {
  apiKey?: string;
  /** Queue base URL (default https://queue.fal.run). */
  baseUrl?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  models?: Partial<FalModels>;
  fetch?: FetchFn;
}

const SubmitSchema = z.object({
  request_id: z.string(),
  status_url: z.string().url().optional(),
  response_url: z.string().url().optional(),
});
const StatusSchema = z.object({
  status: z.enum(["IN_QUEUE", "IN_PROGRESS", "COMPLETED"]),
  queue_position: z.number().optional(),
  error: z.string().nullish(),
});
const FalFile = z.object({ url: z.string(), content_type: z.string().nullish(), width: z.number().nullish(), height: z.number().nullish() });
const ImagesOut = z.object({ images: z.array(FalFile).min(1), seed: z.number().nullish() });
const ImageOut = z.object({ image: FalFile });
const VideoOut = z.object({ video: FalFile });

const ALIASES: Record<string, keyof FalModels> = { schnell: "imageFast", dev: "image", pro: "imagePro" };

/**
 * fal.ai adapter using the documented queue REST API:
 *   POST https://queue.fal.run/{model_id}  (Authorization: Key $FAL_KEY) -> { request_id, status_url, response_url }
 *   GET  status_url until status = COMPLETED, then GET response_url for the model output.
 */
export class FalMediaProvider implements MediaProvider {
  readonly name = "fal";
  readonly isMock = false;
  readonly models: FalModels;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly pollMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: FalOptions = {}) {
    this.models = { ...DEFAULT_FAL_MODELS, ...opts.models };
    this.baseUrl = (opts.baseUrl ?? process.env.FAL_QUEUE_URL ?? "https://queue.fal.run").replace(/\/$/, "");
    this.fetchFn = opts.fetch ?? ((...a) => fetch(...a));
    this.pollMs = opts.pollIntervalMs ?? 1500;
    this.timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  }

  private get key(): string {
    return requireKey(this.opts.apiKey ?? process.env.FAL_KEY, "FAL_KEY");
  }

  private headers(): Record<string, string> {
    return { Authorization: `Key ${this.key}`, "Content-Type": "application/json", Accept: "application/json" };
  }

  /** Submit to the queue, poll status, fetch the result. */
  async queue(modelId: string, input: Record<string, unknown>, opts?: CallOptions): Promise<unknown> {
    const submit = SubmitSchema.parse(
      await readJson(
        await this.fetchFn(`${this.baseUrl}/${modelId}`, { method: "POST", headers: this.headers(), body: JSON.stringify(input), signal: opts?.signal }),
        "fal",
      ),
    );
    const base = `${this.baseUrl}/${modelId}/requests/${submit.request_id}`;
    const statusUrl = submit.status_url ?? `${base}/status`;
    const responseUrl = submit.response_url ?? base;
    opts?.onProgress?.(0.05, "submitted");
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const st = StatusSchema.parse(await readJson(await this.fetchFn(statusUrl, { headers: this.headers(), signal: opts?.signal }), "fal"));
      if (st.status === "COMPLETED") {
        if (st.error) throw new ForgeError("PROVIDER_ERROR", `fal ${modelId} failed: ${st.error}`);
        break;
      }
      opts?.onProgress?.(st.status === "IN_QUEUE" ? 0.1 : 0.5, st.status === "IN_QUEUE" ? `queued (position ${st.queue_position ?? "?"})` : "generating");
      if (Date.now() > deadline) throw new ForgeError("PROVIDER_ERROR", `fal ${modelId} timed out after ${this.timeoutMs} ms`);
      await sleep(this.pollMs, opts?.signal);
    }
    const out = await readJson(await this.fetchFn(responseUrl, { headers: this.headers(), signal: opts?.signal }), "fal");
    opts?.onProgress?.(0.95, "completed");
    return out;
  }

  private imageModel(model?: string): string {
    if (!model) return this.models.image;
    const alias = ALIASES[model];
    return alias ? this.models[alias] : model;
  }

  modelFor(job: MediaJob): string {
    switch (job.type) {
      case "text-to-image":
        return this.imageModel(job.model);
      case "edit-image":
        return job.model ?? (job.mask ? this.models.editMask : this.models.edit);
      case "remove-background":
        return job.model ?? this.models.removeBackground;
      case "upscale":
        return job.model ?? this.models.upscale;
      case "text-to-video":
        return job.model ?? this.models.textToVideo;
      case "image-to-video":
        return job.model ?? this.models.imageToVideo;
    }
  }

  estimate(job: MediaJob): CostEstimate {
    const model = this.modelFor(job);
    const seconds = "durationSec" in job ? videoDuration(model, job.durationSec).seconds : undefined;
    return estimateFromTable(job, model, seconds);
  }

  async textToImage(input: TextToImageInput, opts?: CallOptions): Promise<MediaResult> {
    const model = this.imageModel(input.model);
    const prompt = input.style ? `${input.prompt}, ${input.style}` : input.prompt;
    const body: Record<string, unknown> = {
      prompt,
      image_size: { width: input.width, height: input.height },
      num_images: input.n,
      enable_safety_checker: true,
      output_format: "png",
    };
    if (input.seed !== undefined) body.seed = input.seed;
    // FLUX has no negative prompt input; it is intentionally not sent.
    const out = ImagesOut.parse(await this.queue(model, body, opts));
    const items: MediaItem[] = out.images.map((im) => ({
      url: im.url,
      mimeType: im.content_type ?? "image/png",
      width: im.width ?? input.width,
      height: im.height ?? input.height,
      meta: { seed: out.seed ?? input.seed },
    }));
    const price = priceFor(model);
    const units = price.unit === "megapixel" ? items.reduce((a, i) => a + megapixels(i.width ?? input.width, i.height ?? input.height), 0) : items.length;
    return { items, costUsd: costForUnits(price, units), provider: this.name, model };
  }

  async editImage(input: EditImageInput, opts?: CallOptions): Promise<MediaResult> {
    const model = input.model ?? (input.mask ? this.models.editMask : this.models.edit);
    const body: Record<string, unknown> = { prompt: input.prompt, image_url: imageToUrl(input.image), output_format: "png" };
    if (input.mask) body.mask_url = imageToUrl(input.mask);
    const out = ImagesOut.parse(await this.queue(model, body, opts));
    const items = out.images.map((im) => ({ url: im.url, mimeType: im.content_type ?? "image/png", width: im.width ?? undefined, height: im.height ?? undefined }));
    const price = priceFor(model);
    const units = price.unit === "megapixel" ? items.reduce((a, i) => a + megapixels(i.width ?? 1024, i.height ?? 1024), 0) : items.length;
    return { items, costUsd: costForUnits(price, units), provider: this.name, model };
  }

  async removeBackground(input: RemoveBackgroundInput, opts?: CallOptions): Promise<MediaResult> {
    const model = input.model ?? this.models.removeBackground;
    const out = ImageOut.parse(await this.queue(model, { image_url: imageToUrl(input.image) }, opts));
    return {
      items: [{ url: out.image.url, mimeType: out.image.content_type ?? "image/png", width: out.image.width ?? undefined, height: out.image.height ?? undefined }],
      costUsd: costForUnits(priceFor(model), 1),
      provider: this.name,
      model,
    };
  }

  async upscale(input: UpscaleInput, opts?: CallOptions): Promise<MediaResult> {
    const model = input.model ?? this.models.upscale;
    const out = ImageOut.parse(await this.queue(model, { image_url: imageToUrl(input.image), scale: input.scale, output_format: "png" }, opts));
    return {
      items: [{ url: out.image.url, mimeType: out.image.content_type ?? "image/png", width: out.image.width ?? undefined, height: out.image.height ?? undefined }],
      costUsd: costForUnits(priceFor(model), 1),
      provider: this.name,
      model,
    };
  }

  async textToVideo(input: TextToVideoInput, opts?: CallOptions): Promise<MediaResult> {
    const model = input.model ?? this.models.textToVideo;
    const d = videoDuration(model, input.durationSec);
    const body: Record<string, unknown> = { prompt: input.prompt, duration: d.param, aspect_ratio: videoAspect(model, input.aspectRatio) };
    if (isVeo(model)) body.generate_audio = false;
    const out = VideoOut.parse(await this.queue(model, body, opts));
    return {
      items: [{ url: out.video.url, mimeType: out.video.content_type ?? "video/mp4", durationSec: d.seconds }],
      costUsd: costForUnits(priceFor(model), d.seconds),
      provider: this.name,
      model,
    };
  }

  async imageToVideo(input: ImageToVideoInput, opts?: CallOptions): Promise<MediaResult> {
    const model = input.model ?? this.models.imageToVideo;
    const d = videoDuration(model, input.durationSec);
    const body: Record<string, unknown> = { prompt: input.prompt, image_url: imageToUrl(input.image), duration: d.param };
    if (isVeo(model)) body.generate_audio = false;
    const out = VideoOut.parse(await this.queue(model, body, opts));
    return {
      items: [{ url: out.video.url, mimeType: out.video.content_type ?? "video/mp4", durationSec: d.seconds }],
      costUsd: costForUnits(priceFor(model), d.seconds),
      provider: this.name,
      model,
    };
  }
}

function isVeo(model: string): boolean {
  return model.includes("veo");
}

/** Snap a requested duration to what the model accepts (and is billed for). */
export function videoDuration(model: string, requested: number): { seconds: number; param: string } {
  if (isVeo(model)) {
    const s = [4, 6, 8].find((x) => x >= requested) ?? 8;
    return { seconds: s, param: `${s}s` };
  }
  if (model.includes("kling")) {
    const s = requested <= 5 ? 5 : 10;
    return { seconds: s, param: String(s) };
  }
  const s = Math.ceil(requested);
  return { seconds: s, param: String(s) };
}

function videoAspect(model: string, ar: AspectRatio): string {
  if (isVeo(model)) return ar === "9:16" || ar === "3:4" ? "9:16" : "16:9";
  if (ar === "4:3") return "16:9";
  if (ar === "3:4") return "9:16";
  return ar;
}
