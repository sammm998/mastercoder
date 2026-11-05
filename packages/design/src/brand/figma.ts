import { z } from "zod";
import { rgbToHex } from "../color.js";
import type { BrandInput } from "../types.js";

/** Subset of the Figma REST API file format we read (https://www.figma.com/developers/api#files). */
export const FigmaColorSchema = z.object({ r: z.number(), g: z.number(), b: z.number(), a: z.number().optional() });
export const FigmaPaintSchema = z.object({ type: z.string(), visible: z.boolean().optional(), color: FigmaColorSchema.optional(), opacity: z.number().optional() }).passthrough();
export const FigmaTypeStyleSchema = z.object({ fontFamily: z.string().optional(), fontWeight: z.number().optional(), fontSize: z.number().optional() }).passthrough();

export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];
  fills?: Array<z.infer<typeof FigmaPaintSchema>>;
  style?: z.infer<typeof FigmaTypeStyleSchema>;
  styles?: Record<string, string>;
}

export const FigmaNodeSchema: z.ZodType<FigmaNode> = z.lazy(() =>
  z
    .object({
      id: z.string(),
      name: z.string(),
      type: z.string(),
      children: z.array(FigmaNodeSchema).optional(),
      fills: z.array(FigmaPaintSchema).optional(),
      style: FigmaTypeStyleSchema.optional(),
      styles: z.record(z.string()).optional(),
    })
    .passthrough(),
) as z.ZodType<FigmaNode>;

export const FigmaStyleMetaSchema = z.object({ key: z.string().optional(), name: z.string(), styleType: z.string(), description: z.string().optional() }).passthrough();

export const FigmaFileSchema = z
  .object({
    name: z.string(),
    document: FigmaNodeSchema,
    styles: z.record(FigmaStyleMetaSchema).default({}),
  })
  .passthrough();
export type FigmaFile = z.infer<typeof FigmaFileSchema>;

export interface FigmaClient {
  readonly name: string;
  readonly isMock: boolean;
  getFile(fileKey: string): Promise<FigmaFile>;
}

export interface FigmaStyles {
  colors: Array<{ name: string; hex: string }>;
  text: Array<{ name: string; fontFamily: string; fontWeight?: number; fontSize?: number }>;
}

/** Resolve local style ids to values by finding the first node that uses each style. */
export function extractFigmaStyles(file: FigmaFile): FigmaStyles {
  const colors = new Map<string, { name: string; hex: string }>();
  const text = new Map<string, FigmaStyles["text"][number]>();
  const walk = (n: FigmaNode) => {
    for (const [kind, styleId] of Object.entries(n.styles ?? {})) {
      const meta = file.styles[styleId];
      if (!meta) continue;
      if ((kind === "fill" || kind === "fills") && meta.styleType === "FILL" && !colors.has(styleId)) {
        const paint = n.fills?.find((f) => f.type === "SOLID" && f.visible !== false && f.color);
        if (paint?.color) colors.set(styleId, { name: meta.name, hex: rgbToHex(paint.color) });
      }
      if (kind === "text" && meta.styleType === "TEXT" && !text.has(styleId) && n.style?.fontFamily) {
        text.set(styleId, { name: meta.name, fontFamily: n.style.fontFamily, fontWeight: n.style.fontWeight, fontSize: n.style.fontSize });
      }
    }
    n.children?.forEach(walk);
  };
  walk(file.document);
  return { colors: [...colors.values()], text: [...text.values()] };
}

/** Map Figma colour/text styles onto brand roles by style name. */
export function figmaToBrand(file: FigmaFile): BrandInput {
  const { colors, text } = extractFigmaStyles(file);
  const find = <T extends { name: string }>(list: T[], re: RegExp) => list.find((x) => re.test(x.name));
  const primary = find(colors, /primary|brand|accent(?!.?2)/i);
  const secondary = find(colors, /secondary|accent.?2|highlight/i);
  const background = find(colors, /background|^bg|\/bg|canvas|base$/i);
  const textColor = find(colors, /text|foreground|ink|on.?background/i);
  const display = find(text, /display|heading|headline|h1|title/i) ?? [...text].sort((a, b) => (b.fontSize ?? 0) - (a.fontSize ?? 0))[0];
  const body = find(text, /body|paragraph|text|copy/i) ?? [...text].sort((a, b) => (a.fontSize ?? 99) - (b.fontSize ?? 99))[0];
  return {
    name: file.name,
    colors: {
      ...(primary ? { primary: primary.hex } : {}),
      ...(secondary ? { secondary: secondary.hex } : {}),
      ...(background ? { background: background.hex } : {}),
      ...(textColor ? { text: textColor.hex } : {}),
    },
    fonts: { ...(display ? { display: display.fontFamily } : {}), ...(body ? { body: body.fontFamily } : {}) },
    source: "figma",
    notes: [`figma file "${file.name}": ${colors.length} colour styles, ${text.length} text styles`],
  };
}
