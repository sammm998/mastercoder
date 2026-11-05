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
import { costForUnits, priceFor } from "../pricing.js";
import { estimateFromTable } from "../estimate.js";
import { sleep } from "../util.js";
import { imageToUrl, readJson, requireKey, type FetchFn } from "./http.js";

export interface ReplicateModels {
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

export const DEFAULT_REPLICATE_MODELS: ReplicateModels = {
  imageFast: "black-forest-labs/flux-schnell",
  image: "black-forest-labs/flux-dev",
  imagePro: "black-forest-labs/flux-1.1-pro",
  edit: "black-forest-labs/flux-kontext-pro",
  editMask: "black-forest-labs/flux-fill-pro",
  removeBackground: "recraft-ai/recraft-remove-background",
  upscale: "recraft-ai/recraft-crisp-upscale",
  textToVideo: "kwaivgi/kling-v2.5-turbo-pro",
  // Same model with a start image; the "#i2v" suffix only selects the price row.
  imageToVideo: "kwaivgi/kling-v2.5-turbo-pro#i2v",
};

export interface ReplicateOptions {
  apiToken?: string;
  baseUrl?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  models?: Partial<ReplicateModels>;
  fetch?: FetchFn;
}

const PredictionSchema = z.object({
  id: z.string(),
  status: z.enum(["starting", "processing", "succeeded", "failed", "canceled"]),
  output: z.unknown().optional(),
  error: z.unknown().optional(),
  urls: z.object({ get: z.string().url() }).partial().optional(),
});
type Prediction = z.infer<typeof PredictionSchema>;

const OutputUrls = z.union([z.string(), z.array(z.string()).min(1)]);

const ALIASES: Record<string, keyof ReplicateModels> = { schnell: "imageFast", dev: "image", pro: "imagePro" };
/** Models that accept num_outputs; others are called n times. */
const MULTI_OUTPUT = new Set(["black-forest-labs/flux-schnell", "black-forest-labs/flux-dev"]);
const RATIOS: Array<[string, number]> = [
  ["1:1", 1], ["16:9", 16 / 9], ["21:9", 21 / 9], ["3:2", 1.5], ["2:3", 2 / 3], ["4:5", 0.8], ["5:4", 1.25], ["3:4", 0.75], ["4:3", 4 / 3], ["9:16", 9 / 16], ["9:21", 9 / 21],
];

export function closestAspect(width: number, height: number): string {
  const r = width / height;
  let best = RATIOS[0] as [string, number];
  for (const x of RATIOS) if (Math.abs(Math.log(x[1] / r)) < Math.abs(Math.log(best[1] / r))) best = x;
  return best[0];
}

/**
 * Replicate adapter using the predictions REST API:
 *   POST https://api.replicate.com/v1/models/{owner}/{name}/predictions  (Authorization: Bearer $REPLICATE_API_TOKEN)
 *   or POST /v1/predictions { version } for "owner/name:version" ids; poll `urls.get` until a terminal status.
 */
export class ReplicateMediaProvider implements MediaProvider {
  readonly name = "replicate";
  readonly isMock = false;
  readonly models: ReplicateModels;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly pollMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: ReplicateOptions = {}) {
    this.models = { ...DEFAULT_REPLICATE_MODELS, ...opts.models };
    this.baseUrl = (opts.baseUrl ?? "https://api.replicate.com/v1").replace(/\/$/, "");
    this.fetchFn = opts.fetch ?? ((...a) => fetch(...a));
    this.pollMs = opts.pollIntervalMs ?? 1500;
    this.timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  }

  private headers(): Record<string, string> {
    const token = requireKey(this.opts.apiToken ?? process.env.REPLICATE_API_TOKEN, "REPLICATE_API_TOKEN");
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  }

  /** Create a prediction and poll until it finishes. Returns the raw output. */
  async predict(model: string, input: Record<string, unknown>, opts?: CallOptions): Promise<unknown> {
    const id = model.split("#")[0] as string;
    const [ref, version] = id.split(":");
    const url = version ? `${this.baseUrl}/predictions` : `${this.baseUrl}/models/${ref}/predictions`;
    const body = version ? { version, input } : { input };
    let p: Prediction = PredictionSchema.parse(
      await readJson(await this.fetchFn(url, { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: opts?.signal }), "replicate"),
    );
    opts?.onProgress?.(0.05, "submitted");
    const getUrl = p.urls?.get ?? `${this.baseUrl}/predictions/${p.id}`;
    const deadline = Date.now() + this.timeoutMs;
    while (p.status === "starting" || p.status === "processing") {
      opts?.onProgress?.(p.status === "starting" ? 0.1 : 0.5, p.status);
      if (Date.now() > deadline) throw new ForgeError("PROVIDER_ERROR", `replicate ${model} timed out`);
      await sleep(this.pollMs, opts?.signal);
      p = PredictionSchema.parse(await readJson(await this.fetchFn(getUrl, { headers: this.headers(), signal: opts?.signal }), "replicate"));
    }
    if (p.status !== "succeeded") {
      throw new ForgeError("PROVIDER_ERROR", `replicate ${model} ${p.status}: ${String(p.error ?? "no error message")}`);
    }
    opts?.onProgress?.(0.95, "succeeded");
    return p.output;
  }

  private urls(output: unknown): string[] {
    const o = OutputUrls.parse(output);
    return typeof o === "string" ? [o] : o;
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
    const seconds = "durationSec" in job ? replicateDuration(model, job.durationSec) : undefined;
    return estimateFromTable(job, model, seconds);
  }

  async textToImage(input: TextToImageInput, opts?: CallOptions): Promise<MediaResult> {
    const model = this.imageModel(input.model);
    const prompt = input.style ? `${input.prompt}, ${input.style}` : input.prompt;
    const base: Record<string, unknown> = { prompt, aspect_ratio: closestAspect(input.width, input.height), output_format: "png" };
    if (input.seed !== undefined) base.seed = input.seed;
    const urls: string[] = [];
    if (MULTI_OUTPUT.has(model)) {
      urls.push(...this.urls(await this.predict(model, { ...base, num_outputs: Math.min(input.n, 4) }, opts)));
    }
    while (urls.length < input.n) {
      const seed = input.seed !== undefined ? input.seed + urls.length : undefined;
      urls.push(...this.urls(await this.predict(model, { ...base, ...(seed !== undefined ? { seed } : {}) }, opts)));
    }
    const items: MediaItem[] = urls.slice(0, input.n).map((url) => ({ url, mimeType: "image/png", meta: { seed: input.seed } }));
    return { items, costUsd: costForUnits(priceFor(model), items.length), provider: this.name, model };
  }

  async editImage(input: EditImageInput, opts?: CallOptions): Promise<MediaResult> {
    const model = input.model ?? (input.mask ? this.models.editMask : this.models.edit);
    const body: Record<string, unknown> = input.mask
      ? { prompt: input.prompt, image: imageToUrl(input.image), mask: imageToUrl(input.mask), output_format: "png" }
      : { prompt: input.prompt, input_image: imageToUrl(input.image), output_format: "png" };
    const urls = this.urls(await this.predict(model, body, opts));
    return { items: urls.map((url) => ({ url, mimeType: "image/png" })), costUsd: costForUnits(priceFor(model), urls.length), provider: this.name, model };
  }

  async removeBackground(input: RemoveBackgroundInput, opts?: CallOptions): Promise<MediaResult> {
    const model = input.model ?? this.models.removeBackground;
    const urls = this.urls(await this.predict(model, { image: imageToUrl(input.image) }, opts));
    return { items: urls.slice(0, 1).map((url) => ({ url, mimeType: "image/png" })), costUsd: costForUnits(priceFor(model), 1), provider: this.name, model };
  }

  async upscale(input: UpscaleInput, opts?: CallOptions): Promise<MediaResult> {
    const model = input.model ?? this.models.upscale;
    const urls = this.urls(await this.predict(model, { image: imageToUrl(input.image), scale: input.scale }, opts));
    return { items: urls.slice(0, 1).map((url) => ({ url, mimeType: "image/png" })), costUsd: costForUnits(priceFor(model), 1), provider: this.name, model };
  }

  async textToVideo(input: TextToVideoInput, opts?: CallOptions): Promise<MediaResult> {
    const model = input.model ?? this.models.textToVideo;
    const seconds = replicateDuration(model, input.durationSec);
    const urls = this.urls(await this.predict(model, { prompt: input.prompt, duration: seconds, aspect_ratio: aspect(input.aspectRatio) }, opts));
    return { items: [{ url: urls[0] as string, mimeType: "video/mp4", durationSec: seconds }], costUsd: costForUnits(priceFor(model), seconds), provider: this.name, model };
  }

  async imageToVideo(input: ImageToVideoInput, opts?: CallOptions): Promise<MediaResult> {
    const model = input.model ?? this.models.imageToVideo;
    const seconds = replicateDuration(model, input.durationSec);
    const imageKey = model.includes("veo") ? "image" : "start_image";
    const urls = this.urls(await this.predict(model, { prompt: input.prompt, duration: seconds, [imageKey]: imageToUrl(input.image) }, opts));
    return { items: [{ url: urls[0] as string, mimeType: "video/mp4", durationSec: seconds }], costUsd: costForUnits(priceFor(model), seconds), provider: this.name, model };
  }
}

export function replicateDuration(model: string, requested: number): number {
  if (model.includes("kling")) return requested <= 5 ? 5 : 10;
  if (model.includes("veo")) return [4, 6, 8].find((x) => x >= requested) ?? 8;
  return Math.ceil(requested);
}

function aspect(ar: AspectRatio): string {
  return ar === "4:3" ? "16:9" : ar === "3:4" ? "9:16" : ar;
}
