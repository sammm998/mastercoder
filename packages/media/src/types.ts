import { z } from "zod";
import type { CostEstimate } from "@forge/shared";

/** Image input: raw bytes, an https URL or a data: URI. */
export const ImageInputSchema = z.union([
  z.custom<Uint8Array>((v) => v instanceof Uint8Array, "image must be bytes, an http(s) URL or a data:image URI"),
  z.string().refine((s) => /^(https?:\/\/|data:image\/)/.test(s), "image must be an http(s) URL or data:image URI"),
]);
export type ImageInput = z.infer<typeof ImageInputSchema>;

export const AspectRatioSchema = z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]);
export type AspectRatio = z.infer<typeof AspectRatioSchema>;

export const TextToImageInputSchema = z.object({
  prompt: z.string().min(1).max(4000),
  negativePrompt: z.string().max(2000).optional(),
  width: z.number().int().min(64).max(4096),
  height: z.number().int().min(64).max(4096),
  n: z.number().int().min(1).max(8),
  seed: z.number().int().nonnegative().optional(),
  /** Free-text style suffix appended to the prompt (see styleFromBrand). */
  style: z.string().max(1000).optional(),
  /** Optional brand palette (hex) — used by the mock renderer and folded into the prompt by real adapters via `style`. */
  palette: z.array(z.string()).max(12).optional(),
  model: z.string().optional(),
});
export type TextToImageInput = z.infer<typeof TextToImageInputSchema>;

export const EditImageInputSchema = z.object({
  image: ImageInputSchema,
  prompt: z.string().min(1).max(4000),
  mask: ImageInputSchema.optional(),
  model: z.string().optional(),
});
export type EditImageInput = z.infer<typeof EditImageInputSchema>;

export const RemoveBackgroundInputSchema = z.object({ image: ImageInputSchema, model: z.string().optional() });
export type RemoveBackgroundInput = z.infer<typeof RemoveBackgroundInputSchema>;

export const UpscaleInputSchema = z.object({
  image: ImageInputSchema,
  scale: z.number().min(1).max(8),
  model: z.string().optional(),
});
export type UpscaleInput = z.infer<typeof UpscaleInputSchema>;

export const TextToVideoInputSchema = z.object({
  prompt: z.string().min(1).max(4000),
  durationSec: z.number().min(1).max(60),
  aspectRatio: AspectRatioSchema,
  model: z.string().optional(),
  palette: z.array(z.string()).max(12).optional(),
});
export type TextToVideoInput = z.infer<typeof TextToVideoInputSchema>;

export const ImageToVideoInputSchema = z.object({
  image: ImageInputSchema,
  prompt: z.string().min(1).max(4000),
  durationSec: z.number().min(1).max(60),
  model: z.string().optional(),
});
export type ImageToVideoInput = z.infer<typeof ImageToVideoInputSchema>;

export interface MediaItem {
  bytes?: Uint8Array;
  url?: string;
  mimeType: string;
  width?: number;
  height?: number;
  durationSec?: number;
  /** Extra provider metadata (e.g. `{ mock: true }`, seed). */
  meta?: Record<string, unknown>;
}

export interface MediaResult {
  items: MediaItem[];
  /** Provider cost in USD for this call (price table in pricing.ts). */
  costUsd: number;
  provider: string;
  model: string;
}

export const MediaJobSchema = z.discriminatedUnion("type", [
  TextToImageInputSchema.extend({ type: z.literal("text-to-image") }),
  EditImageInputSchema.extend({ type: z.literal("edit-image") }),
  RemoveBackgroundInputSchema.extend({ type: z.literal("remove-background") }),
  UpscaleInputSchema.extend({ type: z.literal("upscale") }),
  TextToVideoInputSchema.extend({ type: z.literal("text-to-video") }),
  ImageToVideoInputSchema.extend({ type: z.literal("image-to-video") }),
]);
export type MediaJob = z.infer<typeof MediaJobSchema>;
export type MediaJobType = MediaJob["type"];

export interface CallOptions {
  /** Progress 0..1 with an optional label (queue position, status). */
  onProgress?: (progress: number, label?: string) => void;
  signal?: AbortSignal;
}

export interface MediaProvider {
  readonly name: string;
  readonly isMock: boolean;
  textToImage(input: TextToImageInput, opts?: CallOptions): Promise<MediaResult>;
  editImage(input: EditImageInput, opts?: CallOptions): Promise<MediaResult>;
  removeBackground(input: RemoveBackgroundInput, opts?: CallOptions): Promise<MediaResult>;
  upscale(input: UpscaleInput, opts?: CallOptions): Promise<MediaResult>;
  textToVideo(input: TextToVideoInput, opts?: CallOptions): Promise<MediaResult>;
  imageToVideo(input: ImageToVideoInput, opts?: CallOptions): Promise<MediaResult>;
  /** Cost estimate for a job before running it (provider cost, no markup). */
  estimate(job: MediaJob): CostEstimate;
}

/** Dispatch a validated job to the matching provider method. */
export function runOnProvider(provider: MediaProvider, job: MediaJob, opts?: CallOptions): Promise<MediaResult> {
  switch (job.type) {
    case "text-to-image": {
      const { type: _t, ...input } = job;
      return provider.textToImage(input, opts);
    }
    case "edit-image": {
      const { type: _t, ...input } = job;
      return provider.editImage(input, opts);
    }
    case "remove-background": {
      const { type: _t, ...input } = job;
      return provider.removeBackground(input, opts);
    }
    case "upscale": {
      const { type: _t, ...input } = job;
      return provider.upscale(input, opts);
    }
    case "text-to-video": {
      const { type: _t, ...input } = job;
      return provider.textToVideo(input, opts);
    }
    case "image-to-video": {
      const { type: _t, ...input } = job;
      return provider.imageToVideo(input, opts);
    }
  }
}

/** Text that moderation must check for a job. */
export function jobPrompt(job: MediaJob): string {
  switch (job.type) {
    case "text-to-image":
      // negativePrompt lists what must NOT appear, so it is not moderated as requested content.
      return [job.prompt, job.style].filter(Boolean).join("\n");
    case "edit-image":
    case "text-to-video":
    case "image-to-video":
      return job.prompt;
    case "remove-background":
    case "upscale":
      return "";
  }
}

/** Images attached to a job (for the optional vision moderation check). */
export function jobImages(job: MediaJob): ImageInput[] {
  switch (job.type) {
    case "edit-image":
      return job.mask ? [job.image, job.mask] : [job.image];
    case "remove-background":
    case "upscale":
    case "image-to-video":
      return [job.image];
    default:
      return [];
  }
}
