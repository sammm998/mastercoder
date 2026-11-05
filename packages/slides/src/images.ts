import sharp from "sharp";
import type { Deck, DeckTheme, Doc, ImageRef } from "./schema.js";
import { DEFAULT_THEME, escapeHtml } from "./theme.js";

export interface ImageRequest {
  prompt?: string;
  artifactId?: string;
  url?: string;
  alt: string;
  width: number;
  height: number;
}

export interface ResolvedImage {
  bytes?: Uint8Array;
  url?: string;
  mimeType: string;
}

/**
 * Turns an image reference (generation prompt, stored artifact id or URL) into bytes or a URL.
 * Injected by the caller (e.g. backed by @forge/media's MediaJobService + ObjectStore) so slides stays
 * decoupled from media.
 */
export interface ImageResolver {
  resolve(req: ImageRequest): Promise<ResolvedImage>;
}

/** Adapt a plain function to an ImageResolver. */
export function imageResolver(fn: (req: ImageRequest) => Promise<ResolvedImage>): ImageResolver {
  return { resolve: fn };
}

/**
 * Local resolver that renders a clearly labelled placeholder (alt text + "Image placeholder") with sharp.
 * Useful offline/in tests; it does not generate imagery.
 */
export class PlaceholderImageResolver implements ImageResolver {
  readonly calls: ImageRequest[] = [];
  constructor(private readonly theme: DeckTheme = DEFAULT_THEME) {}
  async resolve(req: ImageRequest): Promise<ResolvedImage> {
    this.calls.push(req);
    const { width: w, height: h } = req;
    const c = this.theme.colors;
    const fs = Math.round(Math.min(Math.min(w, h) / 14, (w * 1.5) / Math.max(12, Math.min(req.alt.length, 60))));
    const alt = escapeHtml(req.alt.length > 60 ? `${req.alt.slice(0, 57)}...` : req.alt);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c.accent}"/><stop offset="1" stop-color="${c.accent2}"/></linearGradient></defs>
<rect width="${w}" height="${h}" fill="url(#g)"/>
<rect x="${w * 0.06}" y="${h * 0.08}" width="${w * 0.88}" height="${h * 0.84}" rx="${fs}" fill="#000" opacity="0.18"/>
<text x="${w / 2}" y="${h / 2 - fs * 0.4}" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="${fs}" fill="#fff">${alt}</text>
<text x="${w / 2}" y="${h / 2 + fs * 1.1}" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="${fs * 0.6}" fill="#fff" opacity="0.85">Image placeholder</text>
</svg>`;
    return { bytes: new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer()), mimeType: "image/png" };
  }
}

export function toDataUri(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** Load bytes for an image ref that has a data: or http(s) URL. Returns undefined otherwise. */
export async function loadImageBytes(ref: ImageRef | undefined): Promise<{ bytes: Uint8Array; mimeType: string } | undefined> {
  const url = ref?.url;
  if (!url) return undefined;
  const m = url.match(/^data:([^;,]+);base64,(.*)$/s);
  if (m) return { bytes: new Uint8Array(Buffer.from(m[2] as string, "base64")), mimeType: m[1] as string };
  if (/^https?:\/\//.test(url)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Image download failed (${res.status}) for ${url}`);
    return { bytes: new Uint8Array(await res.arrayBuffer()), mimeType: res.headers.get("content-type") ?? "image/png" };
  }
  return undefined;
}

async function resolveRef(ref: ImageRef, resolver: ImageResolver, width: number, height: number): Promise<ImageRef> {
  if (ref.url && /^(data:|https?:\/\/)/.test(ref.url)) return ref;
  const r = await resolver.resolve({ prompt: ref.prompt, artifactId: ref.artifactId, url: ref.url, alt: ref.alt, width, height });
  const url = r.bytes ? toDataUri(r.bytes, r.mimeType) : r.url;
  return url ? { ...ref, url } : ref;
}

/** Resolve every slide image without a usable URL (prompt/artifactId) through the resolver; returns a new deck. */
export async function resolveDeckImages(deck: Deck, resolver: ImageResolver): Promise<Deck> {
  const slides = await Promise.all(
    deck.slides.map(async (s) => {
      if (!s.image) return s;
      const full = s.layout === "image-full";
      return { ...s, image: await resolveRef(s.image, resolver, full ? 1600 : 960, full ? 900 : 1080) };
    }),
  );
  return { ...deck, slides };
}

/** Resolve every document image block; returns a new doc. */
export async function resolveDocImages(doc: Doc, resolver: ImageResolver): Promise<Doc> {
  const sections = await Promise.all(
    doc.sections.map(async (sec) => ({
      ...sec,
      blocks: await Promise.all(sec.blocks.map(async (b) => (b.type === "image" ? { ...b, image: await resolveRef(b.image, resolver, 1200, 675) } : b))),
    })),
  );
  return { ...doc, sections };
}
