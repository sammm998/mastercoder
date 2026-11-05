import { z } from "zod";
import type { MediaProvider, MediaResult } from "./types.js";
import { hash32, isHexColor, normalizeHex } from "./util.js";
import { assertAllowed, type ModerateOptions } from "./moderation/index.js";

export const BrandSchema = z.object({
  /** Hex colours, either a list or named tokens ({ bg, accent, ... }). */
  palette: z.union([z.array(z.string()), z.record(z.string())]),
  mood: z.string().min(1).max(200),
  styleSuffix: z.string().max(500).optional(),
  /** Display font family (used for wordmarks and Remotion themes). */
  fontFamily: z.string().max(100).optional(),
});
export type Brand = z.infer<typeof BrandSchema>;

export interface BrandStyle {
  /** Prompt suffix shared by every image in a set. */
  suffix: string;
  /** Shared seed so an image set keeps a consistent look. */
  seed: number;
  palette: string[];
}

export function paletteList(p: Brand["palette"]): string[] {
  const values = Array.isArray(p) ? p : Object.values(p);
  return [...new Set(values.filter(isHexColor).map(normalizeHex))];
}

/** Build a style suffix + deterministic seed from brand inputs so all images in a set share a style. */
export function styleFromBrand(brand: Brand): BrandStyle {
  const b = BrandSchema.parse(brand);
  const palette = paletteList(b.palette);
  const parts = [
    `${b.mood} mood`,
    palette.length ? `colour palette ${palette.join(", ")}` : undefined,
    "consistent art direction across the set, cohesive lighting and composition",
    b.styleSuffix,
  ].filter(Boolean);
  const seed = hash32(`${palette.join(",")}|${b.mood.toLowerCase()}|${b.styleSuffix ?? ""}`) % 2_147_483_647;
  return { suffix: parts.join(", "), seed, palette };
}

export interface ImageSetRequest {
  prompts: string[];
  brand: Brand;
  /** Images per prompt. */
  n: number;
  width?: number;
  height?: number;
  model?: string;
}

export interface ImageSetResult {
  style: BrandStyle;
  results: Array<{ prompt: string; result: MediaResult }>;
  costUsd: number;
}

/** Generate several prompts with one shared brand style + seed (moderated before any provider call). */
export async function generateImageSet(provider: MediaProvider, req: ImageSetRequest, mod: ModerateOptions = {}): Promise<ImageSetResult> {
  const style = styleFromBrand(req.brand);
  for (const prompt of req.prompts) await assertAllowed({ prompt: `${prompt}\n${style.suffix}` }, mod);
  const results: ImageSetResult["results"] = [];
  for (const prompt of req.prompts) {
    const result = await provider.textToImage({
      prompt,
      style: style.suffix,
      seed: style.seed,
      palette: style.palette,
      n: req.n,
      width: req.width ?? 1024,
      height: req.height ?? 1024,
      model: req.model,
    });
    results.push({ prompt, result });
  }
  return { style, results, costUsd: results.reduce((a, r) => a + r.result.costUsd, 0) };
}
