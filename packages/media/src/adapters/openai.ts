import { z } from "zod";
import { ForgeError, type CostEstimate } from "@forge/shared";
import type { CallOptions, EditImageInput, ImageInput, ImageToVideoInput, MediaJob, MediaProvider, MediaResult, RemoveBackgroundInput, TextToImageInput, TextToVideoInput, UpscaleInput } from "../types.js";
import { costForUnits, priceFor } from "../pricing.js";
import { estimateFromTable } from "../estimate.js";
import { sleep } from "../util.js";
import { readJson, requireKey, sniffMime, type FetchFn } from "./http.js";

export interface OpenAIMediaOptions {
  apiKey?: string;
  /** Default https://api.openai.com/v1 */
  baseUrl?: string;
  imageModel?: string;
  videoModel?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  fetch?: FetchFn;
}

const ImagesResponse = z.object({ data: z.array(z.object({ b64_json: z.string().optional(), url: z.string().optional() })) });
const VideoJob = z.object({ id: z.string(), status: z.string(), progress: z.number().optional(), error: z.object({ message: z.string().optional() }).nullish() }).passthrough();

/** gpt-image-1 sizes: pick the one closest to the requested aspect ratio. */
export function imageSize(width: number, height: number): "1024x1024" | "1536x1024" | "1024x1536" {
  const r = width / height;
  return r > 1.2 ? "1536x1024" : r < 0.83 ? "1024x1536" : "1024x1024";
}

/** Sora sizes and the allowed clip lengths (4, 8 or 12 s). */
export function videoSize(aspect: string): "1280x720" | "720x1280" {
  return aspect === "9:16" || aspect === "3:4" ? "720x1280" : "1280x720";
}
export function videoSeconds(d: number): 4 | 8 | 12 {
  return d <= 4 ? 4 : d <= 8 ? 8 : 12;
}

/**
 * OpenAI media: images with gpt-image-1 (text-to-image, edit, background removal via edit) and
 * video with Sora 2 (async job, polled). Upscaling is not offered by OpenAI. Auth: OPENAI_API_KEY.
 */
export class OpenAIMediaProvider implements MediaProvider {
  readonly name = "openai";
  readonly isMock = false;
  private readonly key: string;
  private readonly base: string;
  private readonly f: FetchFn;
  private readonly imageModel: string;
  private readonly videoModel: string;

  constructor(private readonly o: OpenAIMediaOptions = {}) {
    this.key = requireKey(o.apiKey ?? process.env.OPENAI_API_KEY, "OPENAI_API_KEY");
    this.base = (o.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.f = o.fetch ?? fetch;
    this.imageModel = o.imageModel ?? process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1";
    this.videoModel = o.videoModel ?? process.env.OPENAI_VIDEO_MODEL ?? "sora-2";
  }

  private headers(json = true): Record<string, string> {
    return { authorization: `Bearer ${this.key}`, ...(json ? { "content-type": "application/json" } : {}) };
  }

  private priceModel(job: MediaJob): string {
    if (job.type === "text-to-image") return this.imageModel === "gpt-image-1" ? "gpt-image-1" : this.imageModel;
    if (job.type === "edit-image" || job.type === "remove-background") return "gpt-image-1#edit";
    if (job.type === "image-to-video") return "sora-2#i2v";
    return this.videoModel === "sora-2" ? "sora-2" : this.videoModel;
  }

  estimate(job: MediaJob): CostEstimate {
    if (job.type === "upscale") throw new ForgeError("BAD_INPUT", "The OpenAI media provider has no upscaler");
    const seconds = "durationSec" in job ? videoSeconds(job.durationSec) : undefined;
    return estimateFromTable(job, this.priceModel(job), seconds);
  }

  private async images(r: Response, model: string, n: number, w?: number, h?: number): Promise<MediaResult> {
    const body = ImagesResponse.parse(await readJson(r, "openai"));
    const items = body.data.map((d) => {
      if (d.b64_json) {
        const bytes = Uint8Array.from(Buffer.from(d.b64_json, "base64"));
        return { bytes, mimeType: sniffMime(bytes), width: w, height: h };
      }
      return { url: d.url, mimeType: "image/png", width: w, height: h };
    });
    return { items, costUsd: costForUnits(priceFor(model), n), provider: this.name, model: this.imageModel };
  }

  async textToImage(input: TextToImageInput, opts?: CallOptions): Promise<MediaResult> {
    const size = imageSize(input.width, input.height);
    const [w, h] = size.split("x").map(Number) as [number, number];
    const prompt = input.style ? `${input.prompt}. Style: ${input.style}` : input.prompt;
    opts?.onProgress?.(0.1, "generating");
    const r = await this.f(`${this.base}/images/generations`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ model: input.model ?? this.imageModel, prompt, n: input.n, size, quality: "medium" }),
      signal: opts?.signal,
    });
    const out = await this.images(r, "gpt-image-1", input.n, w, h);
    opts?.onProgress?.(1, "done");
    return out;
  }

  private async toBlob(img: ImageInput): Promise<Blob> {
    if (typeof img !== "string") return new Blob([new Uint8Array(img)], { type: sniffMime(img) });
    if (img.startsWith("data:")) {
      const [meta, data] = img.split(",", 2) as [string, string];
      return new Blob([Buffer.from(data, "base64")], { type: meta.slice(5).split(";")[0] });
    }
    const r = await this.f(img);
    if (!r.ok) throw new ForgeError("BAD_INPUT", `Could not fetch image (${r.status})`);
    return r.blob();
  }

  async editImage(input: EditImageInput, opts?: CallOptions): Promise<MediaResult> {
    const form = new FormData();
    form.set("model", input.model ?? this.imageModel);
    form.set("prompt", input.prompt);
    form.set("image", await this.toBlob(input.image), "image.png");
    if (input.mask) form.set("mask", await this.toBlob(input.mask), "mask.png");
    const r = await this.f(`${this.base}/images/edits`, { method: "POST", headers: this.headers(false), body: form, signal: opts?.signal });
    return this.images(r, "gpt-image-1#edit", 1);
  }

  async removeBackground(input: RemoveBackgroundInput, opts?: CallOptions): Promise<MediaResult> {
    const form = new FormData();
    form.set("model", input.model ?? this.imageModel);
    form.set("prompt", "Remove the background completely; keep the subject unchanged.");
    form.set("background", "transparent");
    form.set("image", await this.toBlob(input.image), "image.png");
    const r = await this.f(`${this.base}/images/edits`, { method: "POST", headers: this.headers(false), body: form, signal: opts?.signal });
    return this.images(r, "gpt-image-1#edit", 1);
  }

  async upscale(_input: UpscaleInput): Promise<MediaResult> {
    throw new ForgeError("BAD_INPUT", "The OpenAI media provider has no upscaler; use MEDIA_PROVIDER=fal or replicate for upscaling");
  }

  private async video(body: FormData | string, seconds: number, priceModel: string, opts?: CallOptions): Promise<MediaResult> {
    const isForm = typeof body !== "string";
    const created = VideoJob.parse(await readJson(await this.f(`${this.base}/videos`, { method: "POST", headers: this.headers(!isForm), body, signal: opts?.signal }), "openai"));
    const deadline = Date.now() + (this.o.timeoutMs ?? 15 * 60_000);
    let job = created;
    while (job.status !== "completed") {
      if (job.status === "failed" || job.status === "cancelled") throw new ForgeError("PROVIDER_ERROR", `Sora video ${job.status}: ${job.error?.message ?? "no details"}`);
      if (Date.now() > deadline) throw new ForgeError("PROVIDER_ERROR", "Sora video timed out");
      opts?.onProgress?.(Math.min(0.95, (job.progress ?? 0) / 100), job.status);
      await sleep(this.o.pollIntervalMs ?? 5000);
      job = VideoJob.parse(await readJson(await this.f(`${this.base}/videos/${encodeURIComponent(job.id)}`, { headers: this.headers(false), signal: opts?.signal }), "openai"));
    }
    const content = await this.f(`${this.base}/videos/${encodeURIComponent(job.id)}/content`, { headers: this.headers(false), signal: opts?.signal });
    if (!content.ok) throw new ForgeError("PROVIDER_ERROR", `Sora download HTTP ${content.status}`);
    const bytes = new Uint8Array(await content.arrayBuffer());
    opts?.onProgress?.(1, "done");
    return { items: [{ bytes, mimeType: "video/mp4", durationSec: seconds }], costUsd: costForUnits(priceFor(priceModel), seconds), provider: this.name, model: this.videoModel };
  }

  async textToVideo(input: TextToVideoInput, opts?: CallOptions): Promise<MediaResult> {
    const seconds = videoSeconds(input.durationSec);
    return this.video(JSON.stringify({ model: input.model ?? this.videoModel, prompt: input.prompt, seconds: String(seconds), size: videoSize(input.aspectRatio) }), seconds, "sora-2", opts);
  }

  async imageToVideo(input: ImageToVideoInput, opts?: CallOptions): Promise<MediaResult> {
    const seconds = videoSeconds(input.durationSec);
    const form = new FormData();
    form.set("model", input.model ?? this.videoModel);
    form.set("prompt", input.prompt);
    form.set("seconds", String(seconds));
    form.set("size", "1280x720");
    form.set("input_reference", await this.toBlob(input.image), "reference.png");
    return this.video(form, seconds, "sora-2#i2v", opts);
  }
}
