import sharp from "sharp";
import type { MediaItem, MediaProvider } from "./types.js";
import { type Brand, paletteList, styleFromBrand } from "./brand.js";
import { assertAllowed, type ModerateOptions } from "./moderation/index.js";
import { escapeXml, luminance } from "./util.js";

export const LOGO_SIZES = [1024, 512, 256, 192, 180, 64, 48, 32, 16] as const;

export interface LogoRequest {
  name: string;
  brand: Brand;
  tagline?: string;
  model?: string;
}

export interface LogoResult {
  /** Square transparent PNGs keyed by pixel size (180 = apple-touch-icon, 192/512 = PWA). */
  sizes: Record<number, Uint8Array>;
  /** Multi-resolution favicon.ico (16/32/48, PNG-encoded entries). */
  faviconIco: Uint8Array;
  /** Real SVG wordmark built from the brand font + colours (no model involved). */
  wordmarkSvg: string;
  costUsd: number;
  provider: string;
  models: string[];
}

/** Get bytes for a provider item (download when only a URL was returned). */
export async function itemBytes(item: MediaItem): Promise<Uint8Array> {
  if (item.bytes) return item.bytes;
  if (!item.url) throw new Error("Media item has neither bytes nor url");
  const res = await fetch(item.url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${item.url}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Pack PNGs into an .ico container (Vista+ PNG-compressed entries). */
export function pngsToIco(pngs: Array<{ size: number; png: Uint8Array }>): Uint8Array {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach((p, i) => {
    const o = i * 16;
    dir.writeUInt8(p.size >= 256 ? 0 : p.size, o);
    dir.writeUInt8(p.size >= 256 ? 0 : p.size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(p.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += p.png.length;
  });
  return new Uint8Array(Buffer.concat([header, dir, ...pngs.map((p) => Buffer.from(p.png))]));
}

function pickColors(palette: string[]): { text: string; accent: string; muted: string } {
  const sorted = [...palette].sort((a, b) => luminance(a) - luminance(b));
  const text = sorted[0] ?? "#111111";
  const accent = palette.find((c) => c !== text && luminance(c) > 0.06 && luminance(c) < 0.6) ?? palette[1] ?? "#3355ff";
  const muted = sorted.find((c) => luminance(c) > 0.25 && luminance(c) < 0.7 && c !== accent) ?? "#666666";
  return { text, accent, muted };
}

/** SVG wordmark: monogram badge + name set in the brand display font, with optional tagline. */
export function wordmarkSvg(opts: { name: string; fontFamily?: string; palette: string[]; tagline?: string }): string {
  const { text, accent, muted } = pickColors(opts.palette.length ? opts.palette : ["#111111", "#3355ff"]);
  const font = escapeXml(opts.fontFamily ?? "Inter");
  const fs = 64;
  const nameW = Math.ceil(opts.name.length * fs * 0.62);
  const tagW = opts.tagline ? Math.ceil(opts.tagline.length * 22 * 0.55) : 0;
  const badge = 96;
  const width = badge + 28 + Math.max(nameW, tagW) + 24;
  const height = opts.tagline ? 132 : 112;
  const initial = escapeXml(opts.name.trim().charAt(0).toUpperCase() || "?");
  const badgeText = luminance(accent) > 0.4 ? "#111111" : "#ffffff";
  const fallback = "Inter, 'Helvetica Neue', Arial, sans-serif";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(opts.name)} wordmark">
  <title>${escapeXml(opts.name)}</title>
  <rect x="8" y="8" width="${badge}" height="${badge}" rx="${badge * 0.28}" fill="${accent}"/>
  <text x="${8 + badge / 2}" y="${8 + badge / 2}" dominant-baseline="central" text-anchor="middle" font-family="'${font}', ${fallback}" font-size="${badge * 0.56}" font-weight="700" fill="${badgeText}">${initial}</text>
  <text x="${badge + 28}" y="${opts.tagline ? 70 : 76}" font-family="'${font}', ${fallback}" font-size="${fs}" font-weight="700" letter-spacing="-1" fill="${text}">${escapeXml(opts.name)}</text>
  ${opts.tagline ? `<text x="${badge + 30}" y="112" font-family="'${font}', ${fallback}" font-size="22" fill="${muted}">${escapeXml(opts.tagline)}</text>` : ""}
</svg>`;
}

/**
 * Logo pipeline: moderation → text-to-image with a logo preset → background removal → trim + square
 * transparent sizes and favicon via sharp → SVG wordmark.
 */
export async function generateLogo(provider: MediaProvider, req: LogoRequest, mod: ModerateOptions = {}): Promise<LogoResult> {
  const style = styleFromBrand(req.brand);
  const prompt = `Logo mark for "${req.name}": minimal flat vector icon, bold simple geometric shape, ${req.brand.mood}, centered single subject on a plain white background, no text, no mockup, high contrast`;
  await assertAllowed({ prompt: `${prompt}\n${req.tagline ?? ""}` }, mod);
  const gen = await provider.textToImage({ prompt, style: style.suffix, seed: style.seed, palette: style.palette, n: 1, width: 1024, height: 1024, model: req.model });
  const first = gen.items[0];
  if (!first) throw new Error("Logo generation returned no image");
  const cut = await provider.removeBackground({ image: await itemBytes(first) });
  const cutItem = cut.items[0];
  if (!cutItem) throw new Error("Background removal returned no image");
  let mark: Buffer<ArrayBufferLike> = Buffer.from(await itemBytes(cutItem));
  try {
    mark = await sharp(mark).trim({ threshold: 1 }).png().toBuffer();
  } catch {
    // fully transparent/flat image cannot be trimmed: keep as is
  }
  const square = await sharp(mark)
    .resize(880, 880, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .extend({ top: 72, bottom: 72, left: 72, right: 72, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const sizes: Record<number, Uint8Array> = {};
  for (const s of LOGO_SIZES) sizes[s] = new Uint8Array(await sharp(square).resize(s, s, { kernel: "lanczos3" }).png().toBuffer());
  const faviconIco = pngsToIco([16, 32, 48].map((s) => ({ size: s, png: sizes[s] as Uint8Array })));
  return {
    sizes,
    faviconIco,
    wordmarkSvg: wordmarkSvg({ name: req.name, fontFamily: req.brand.fontFamily, palette: paletteList(req.brand.palette), tagline: req.tagline }),
    costUsd: gen.costUsd + cut.costUsd,
    provider: provider.name,
    models: [gen.model, cut.model],
  };
}
