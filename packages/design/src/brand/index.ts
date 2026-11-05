import { z } from "zod";
import { createFigmaClient } from "../adapters/figma.js";
import { BrandInputSchema, type BrandInput, type BrandInputInit } from "../types.js";
import { type FigmaClient, figmaToBrand } from "./figma.js";
import { brandFromLogo } from "./logo.js";

export * from "./figma.js";
export * from "./logo.js";

export const BrandSourceSchema = z.object({
  /** Logo image bytes or a local file path. */
  logo: z.union([z.custom<Uint8Array | Buffer>((v) => v instanceof Uint8Array, "expected image bytes"), z.string()]).optional(),
  /** Explicit colours/fonts (highest priority). */
  explicit: BrandInputSchema.partial().optional(),
  /** Figma file key (from https://www.figma.com/file/<key>/...) or full URL. */
  figma: z.string().optional(),
});
export type BrandSource = z.input<typeof BrandSourceSchema>;

export function figmaKeyFromUrl(input: string): string {
  const m = /figma\.com\/(?:file|design|proto)\/([A-Za-z0-9]+)/.exec(input);
  return m?.[1] ?? input;
}

/** Merge brand inputs; later entries win per field. */
export function mergeBrands(...brands: Array<BrandInputInit | undefined>): BrandInput {
  const out: BrandInput = BrandInputSchema.parse({});
  const sources = new Set<string>();
  for (const b of brands) {
    if (!b) continue;
    const p = BrandInputSchema.parse(b);
    out.name = p.name ?? out.name;
    out.colors = { ...out.colors, ...Object.fromEntries(Object.entries(p.colors).filter(([, v]) => v)) };
    out.fonts = { ...out.fonts, ...Object.fromEntries(Object.entries(p.fonts).filter(([, v]) => v)) };
    out.notes.push(...p.notes);
    sources.add(p.source);
  }
  out.source = sources.size > 1 ? "merged" : ((sources.values().next().value as BrandInput["source"] | undefined) ?? "explicit");
  return out;
}

/** Import a brand from any combination of logo, Figma file and explicit values (explicit > figma > logo). */
export async function importBrand(sourceIn: BrandSource, deps: { figma?: FigmaClient } = {}): Promise<BrandInput> {
  const source = BrandSourceSchema.parse(sourceIn);
  const fromLogo = source.logo ? await brandFromLogo(typeof source.logo === "string" ? source.logo : Buffer.from(source.logo)) : undefined;
  const fromFigma = source.figma ? figmaToBrand(await (deps.figma ?? createFigmaClient()).getFile(figmaKeyFromUrl(source.figma))) : undefined;
  const explicit = source.explicit ? { ...source.explicit, source: "explicit" as const } : undefined;
  return mergeBrands(fromLogo, fromFigma, explicit);
}
