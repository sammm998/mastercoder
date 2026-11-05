import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { sumEstimate, type CostEstimate } from "@forge/shared";
import type {
  AspectRatio,
  CallOptions,
  EditImageInput,
  ImageInput,
  ImageToVideoInput,
  MediaJob,
  MediaProvider,
  MediaResult,
  RemoveBackgroundInput,
  TextToImageInput,
  TextToVideoInput,
  UpscaleInput,
} from "../types.js";
import { addPngText, escapeXml, hash32, isHexColor, normalizeHex, paletteFromSeed, prng, readableOn } from "../util.js";

const run = promisify(execFile);

export interface MockImageSpec {
  prompt: string;
  width: number;
  height: number;
  seed: number;
  palette?: string[];
  /** Small corner tag, default "MOCK". */
  label?: string;
  caption?: boolean;
}

function latin1(s: string): string {
  return s.normalize("NFKD").replace(/[^\x20-\x7e]/g, "?").slice(0, 300);
}

function usablePalette(p: string[] | undefined, seed: number): string[] {
  const valid = (p ?? []).filter(isHexColor).map(normalizeHex);
  return valid.length >= 2 ? valid : paletteFromSeed(seed);
}

/** Build the deterministic SVG composition used by the mock renderer. */
export function mockCompositionSvg(spec: MockImageSpec): string {
  const { width: w, height: h } = spec;
  const rnd = prng(spec.seed);
  const pal = usablePalette(spec.palette, hash32(spec.prompt));
  const pick = () => pal[Math.floor(rnd() * pal.length)] as string;
  const angle = Math.floor(rnd() * 360);
  const shapes: string[] = [];
  const count = 5 + Math.floor(rnd() * 6);
  for (let i = 0; i < count; i++) {
    const kind = Math.floor(rnd() * 4);
    const color = pick();
    const op = (0.35 + rnd() * 0.5).toFixed(2);
    const cx = rnd() * w;
    const cy = rnd() * h;
    const s = (0.08 + rnd() * 0.35) * Math.min(w, h);
    if (kind === 0) shapes.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${s.toFixed(1)}" fill="${color}" opacity="${op}"/>`);
    else if (kind === 1) {
      const rot = Math.floor(rnd() * 90);
      shapes.push(`<rect x="${(cx - s).toFixed(1)}" y="${(cy - s / 2).toFixed(1)}" width="${(2 * s).toFixed(1)}" height="${s.toFixed(1)}" rx="${(s / 5).toFixed(1)}" fill="${color}" opacity="${op}" transform="rotate(${rot} ${cx.toFixed(1)} ${cy.toFixed(1)})"/>`);
    } else if (kind === 2) {
      const pts = [0, 1, 2].map((k) => {
        const a = (k / 3) * Math.PI * 2 + rnd();
        return `${(cx + Math.cos(a) * s).toFixed(1)},${(cy + Math.sin(a) * s).toFixed(1)}`;
      });
      shapes.push(`<polygon points="${pts.join(" ")}" fill="${color}" opacity="${op}"/>`);
    } else {
      const y0 = cy;
      const amp = s / 2;
      let d = `M0 ${y0.toFixed(1)}`;
      for (let x = 0; x <= w; x += w / 8) d += ` Q${(x + w / 16).toFixed(1)} ${(y0 + (rnd() > 0.5 ? amp : -amp)).toFixed(1)} ${(x + w / 8).toFixed(1)} ${y0.toFixed(1)}`;
      d += ` L${w} ${h} L0 ${h} Z`;
      shapes.push(`<path d="${d}" fill="${color}" opacity="${(Number(op) * 0.6).toFixed(2)}"/>`);
    }
  }
  const fs = Math.max(10, Math.round(Math.min(w, h) / 28));
  const caption = spec.caption === false ? "" : escapeXml(spec.prompt.length > 90 ? `${spec.prompt.slice(0, 87)}...` : spec.prompt);
  const bg0 = pal[0] as string;
  const band = caption
    ? `<rect x="0" y="${h - fs * 2.4}" width="${w}" height="${fs * 2.4}" fill="#000" opacity="0.45"/>
       <text x="${fs}" y="${h - fs * 0.85}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${fs}" fill="#fff">${caption}</text>`
    : "";
  const label = escapeXml(spec.label ?? "MOCK");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs><linearGradient id="g" gradientTransform="rotate(${angle} 0.5 0.5)"><stop offset="0" stop-color="${bg0}"/><stop offset="1" stop-color="${pal[1]}"/></linearGradient></defs>
  <rect width="${w}" height="${h}" fill="url(#g)"/>
  ${shapes.join("\n  ")}
  ${band}
  <rect x="${fs * 0.5}" y="${fs * 0.5}" width="${fs * (label.length * 0.75 + 1.4)}" height="${fs * 1.6}" rx="${fs * 0.3}" fill="${readableOn(bg0) === "#ffffff" ? "#ffffff" : "#111111"}" opacity="0.85"/>
  <text x="${fs * 1.2}" y="${fs * 1.75}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${fs}" font-weight="bold" fill="${readableOn(bg0) === "#ffffff" ? "#111111" : "#ffffff"}">${label}</text>
</svg>`;
}

/** Render a deterministic mock image as PNG, tagged with tEXt chunks forge:mock=true. */
export async function renderMockImage(spec: MockImageSpec): Promise<Uint8Array> {
  const png = await sharp(Buffer.from(mockCompositionSvg(spec))).png().toBuffer();
  return addPngText(new Uint8Array(png), {
    "forge:mock": "true",
    "forge:generator": "MockMediaProvider (sharp SVG composition, not a model)",
    "forge:seed": String(spec.seed),
    "forge:prompt": latin1(spec.prompt),
  });
}

/** Load an ImageInput into bytes (data URIs decoded locally; http(s) URLs fetched). */
export async function loadImage(img: ImageInput): Promise<Uint8Array> {
  if (typeof img !== "string") return img;
  const m = img.match(/^data:[^;,]+(;base64)?,(.*)$/s);
  if (m) return m[1] ? new Uint8Array(Buffer.from(m[2] as string, "base64")) : new Uint8Array(Buffer.from(decodeURIComponent(m[2] as string)));
  const res = await fetch(img);
  if (!res.ok) throw new Error(`Failed to fetch image ${img}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Luminance-key background removal (approximation, NOT a segmentation model): the background luminance is
 * estimated from the four corners and pixels close to it become transparent, with a soft ramp.
 */
export async function luminanceKey(bytes: Uint8Array, opts: { low?: number; high?: number } = {}): Promise<{ png: Uint8Array; width: number; height: number }> {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const lum = (i: number) => (0.2126 * (data[i] as number) + 0.7152 * (data[i + 1] as number) + 0.0722 * (data[i + 2] as number)) / 255;
  const patch = Math.max(1, Math.min(4, Math.floor(Math.min(w, h) / 8)));
  let sum = 0;
  let n = 0;
  for (const [x0, y0] of [[0, 0], [w - patch, 0], [0, h - patch], [w - patch, h - patch]] as Array<[number, number]>) {
    for (let y = y0; y < y0 + patch; y++) for (let x = x0; x < x0 + patch; x++) {
      sum += lum((y * w + x) * 4);
      n++;
    }
  }
  const bgLum = sum / n;
  const low = opts.low ?? 0.04;
  const high = opts.high ?? 0.15;
  for (let i = 0; i < data.length; i += 4) {
    const d = Math.abs(lum(i) - bgLum);
    const a = d <= low ? 0 : d >= high ? 1 : (d - low) / (high - low);
    data[i + 3] = Math.round((data[i + 3] as number) * a);
  }
  const png = await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  return { png: new Uint8Array(png), width: w, height: h };
}

export function videoSize(ar: AspectRatio): { width: number; height: number } {
  const sizes: Record<AspectRatio, [number, number]> = { "16:9": [640, 360], "9:16": [360, 640], "1:1": [480, 480], "4:3": [640, 480], "3:4": [480, 640] };
  const [width, height] = sizes[ar];
  return { width, height };
}

let ffmpegCache: boolean | undefined;
export function hasFfmpeg(): boolean {
  if (ffmpegCache === undefined) {
    const r = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
    ffmpegCache = r.status === 0;
  }
  return ffmpegCache;
}

export type MockVideoFormat = "mp4" | "webp";

/** Ken Burns pan/zoom frames over a base image. */
async function kenBurnsFrames(base: Uint8Array, width: number, height: number, frames: number, seed: number): Promise<Buffer[]> {
  const big = await sharp(base).resize(Math.round(width * 1.35), Math.round(height * 1.35), { fit: "cover" }).png().toBuffer();
  const meta = await sharp(big).metadata();
  const bw = meta.width as number;
  const bh = meta.height as number;
  const rnd = prng(seed);
  const dir = rnd() > 0.5 ? 1 : -1;
  const out: Buffer[] = [];
  for (let f = 0; f < frames; f++) {
    const t = frames === 1 ? 0 : f / (frames - 1);
    const zoom = 1 + 0.3 * (1 - t); // zoom out from 1.3x crop to 1.0x of the enlarged base
    const cw = Math.round(bw / zoom / 1.0);
    const ch = Math.round(bh / zoom / 1.0);
    const maxX = bw - cw;
    const maxY = bh - ch;
    const left = Math.round(maxX * (dir > 0 ? t : 1 - t));
    const top = Math.round(maxY * 0.5);
    out.push(await sharp(big).extract({ left, top, width: cw, height: ch }).resize(width, height).png().toBuffer());
  }
  return out;
}

/**
 * Encode frames: mp4 (H.264) with ffmpeg when it is on PATH, otherwise an animated WebP via sharp.
 */
async function encodeFrames(frames: Buffer[], fps: number, format: MockVideoFormat): Promise<{ bytes: Uint8Array; mimeType: string; renderer: string }> {
  if (format === "mp4") {
    const dir = await mkdtemp(join(tmpdir(), "forge-mock-video-"));
    try {
      await Promise.all(frames.map((f, i) => writeFile(join(dir, `f_${String(i).padStart(4, "0")}.png`), f)));
      const out = join(dir, "out.mp4");
      await run("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", join(dir, "f_%04d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]);
      return { bytes: new Uint8Array(await readFile(out)), mimeType: "video/mp4", renderer: "ffmpeg libx264 (local)" };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const webp = await sharp(frames, { join: { animated: true } }).webp({ loop: 0, delay: Math.round(1000 / fps), quality: 80 }).toBuffer();
  return { bytes: new Uint8Array(webp), mimeType: "image/webp", renderer: "sharp animated WebP (ffmpeg not found)" };
}

export interface MockMediaOptions {
  /** Force a video container; default mp4 if ffmpeg is on PATH, else animated webp. Env: MEDIA_MOCK_VIDEO_FORMAT. */
  videoFormat?: MockVideoFormat;
  /** Frames per second for mock video (default 12). */
  fps?: number;
}

/**
 * Deterministic local media provider. It does real local work with sharp/ffmpeg (PNG compositions from a
 * prompt hash + palette, resize upscaling, luminance-key cut-outs, Ken Burns videos) and labels every output
 * as mock (`meta.mock = true`, PNG tEXt `forge:mock=true`, corner tag "MOCK"). It is not a generative model.
 */
export class MockMediaProvider implements MediaProvider {
  readonly name = "mock";
  readonly isMock = true;
  readonly calls: Array<{ method: string; input: unknown }> = [];
  constructor(private readonly opts: MockMediaOptions = {}) {}

  private videoFormat(): MockVideoFormat {
    const forced = this.opts.videoFormat ?? (process.env.MEDIA_MOCK_VIDEO_FORMAT as MockVideoFormat | undefined);
    if (forced === "webp") return "webp";
    if (forced === "mp4") return hasFfmpeg() ? "mp4" : "webp";
    return hasFfmpeg() ? "mp4" : "webp";
  }

  estimate(job: MediaJob): CostEstimate {
    return sumEstimate([{ label: `mock ${job.type} (local render, no vendor cost)`, usd: 0 }], 0);
  }

  async textToImage(input: TextToImageInput, opts?: CallOptions): Promise<MediaResult> {
    this.calls.push({ method: "textToImage", input });
    const base = input.seed ?? hash32(`${input.prompt}|${input.style ?? ""}`);
    const items = [];
    for (let i = 0; i < input.n; i++) {
      const seed = (base + i) >>> 0;
      const bytes = await renderMockImage({ prompt: input.prompt, width: input.width, height: input.height, seed, palette: input.palette });
      items.push({ bytes, mimeType: "image/png", width: input.width, height: input.height, meta: { mock: true, seed } });
      opts?.onProgress?.((i + 1) / input.n, `rendered ${i + 1}/${input.n}`);
    }
    return { items, costUsd: 0, provider: this.name, model: "mock-composition-v1" };
  }

  async editImage(input: EditImageInput, opts?: CallOptions): Promise<MediaResult> {
    this.calls.push({ method: "editImage", input: { prompt: input.prompt, mask: Boolean(input.mask) } });
    const src = await loadImage(input.image);
    const meta = await sharp(src).metadata();
    const w = meta.width as number;
    const h = meta.height as number;
    const svg = mockCompositionSvg({ prompt: input.prompt, width: w, height: h, seed: hash32(input.prompt), label: "MOCK EDIT", caption: false });
    const data = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer();
    // Global 40% blend; with a mask, alpha follows the mask's luminance (white = edit).
    const maskRaw = input.mask ? await sharp(await loadImage(input.mask)).resize(w, h, { fit: "fill" }).greyscale().raw().toBuffer() : undefined;
    for (let p = 0, i = 0; i < data.length; i += 4, p++) {
      const m = maskRaw ? (maskRaw[p] as number) / 255 : 1;
      data[i + 3] = Math.round(255 * 0.4 * m);
    }
    const blended = await sharp(src)
      .ensureAlpha()
      .composite([{ input: data, raw: { width: w, height: h, channels: 4 } }])
      .png()
      .toBuffer();
    const bytes = addPngText(new Uint8Array(blended), { "forge:mock": "true", "forge:generator": "MockMediaProvider edit (sharp blend, not a model)" });
    opts?.onProgress?.(1, "edited");
    return { items: [{ bytes, mimeType: "image/png", width: w, height: h, meta: { mock: true, masked: Boolean(input.mask) } }], costUsd: 0, provider: this.name, model: "mock-blend-edit-v1" };
  }

  async removeBackground(input: RemoveBackgroundInput, opts?: CallOptions): Promise<MediaResult> {
    this.calls.push({ method: "removeBackground", input: {} });
    const { png, width, height } = await luminanceKey(await loadImage(input.image));
    opts?.onProgress?.(1, "keyed");
    const bytes = addPngText(png, { "forge:mock": "true", "forge:generator": "luminance key approximation (not a segmentation model)" });
    return { items: [{ bytes, mimeType: "image/png", width, height, meta: { mock: true, method: "luminance-key" } }], costUsd: 0, provider: this.name, model: "mock-luminance-key-v1" };
  }

  async upscale(input: UpscaleInput, opts?: CallOptions): Promise<MediaResult> {
    this.calls.push({ method: "upscale", input: { scale: input.scale } });
    const src = await loadImage(input.image);
    const meta = await sharp(src).metadata();
    const width = Math.round((meta.width as number) * input.scale);
    const height = Math.round((meta.height as number) * input.scale);
    const out = await sharp(src).resize(width, height, { kernel: "lanczos3" }).png().toBuffer();
    opts?.onProgress?.(1, "resized");
    return { items: [{ bytes: new Uint8Array(out), mimeType: "image/png", width, height, meta: { mock: true, method: "lanczos3 resize" } }], costUsd: 0, provider: this.name, model: "mock-lanczos3-resize" };
  }

  private async video(base: Uint8Array, width: number, height: number, durationSec: number, seed: number, opts?: CallOptions): Promise<MediaResult> {
    const format = this.videoFormat();
    const fps = format === "mp4" ? (this.opts.fps ?? 12) : Math.min(this.opts.fps ?? 12, 8);
    const count = Math.max(2, Math.round(durationSec * fps));
    opts?.onProgress?.(0.2, `rendering ${count} frames`);
    const frames = await kenBurnsFrames(base, width, height, count, seed);
    opts?.onProgress?.(0.7, "encoding");
    const enc = await encodeFrames(frames, fps, format);
    opts?.onProgress?.(1, "encoded");
    return {
      items: [{ bytes: enc.bytes, mimeType: enc.mimeType, width, height, durationSec: count / fps, meta: { mock: true, renderer: enc.renderer, fps, frames: count } }],
      costUsd: 0,
      provider: this.name,
      model: `mock-kenburns-${format}`,
    };
  }

  async textToVideo(input: TextToVideoInput, opts?: CallOptions): Promise<MediaResult> {
    this.calls.push({ method: "textToVideo", input });
    const { width, height } = videoSize(input.aspectRatio);
    const seed = hash32(input.prompt);
    const base = await renderMockImage({ prompt: input.prompt, width, height, seed, palette: input.palette });
    return this.video(base, width, height, input.durationSec, seed, opts);
  }

  async imageToVideo(input: ImageToVideoInput, opts?: CallOptions): Promise<MediaResult> {
    this.calls.push({ method: "imageToVideo", input: { prompt: input.prompt, durationSec: input.durationSec } });
    const src = await loadImage(input.image);
    const meta = await sharp(src).metadata();
    const w = meta.width as number;
    const h = meta.height as number;
    const scale = Math.min(1, 640 / Math.max(w, h));
    const width = Math.round((w * scale) / 2) * 2;
    const height = Math.round((h * scale) / 2) * 2;
    return this.video(src, width, height, input.durationSec, hash32(input.prompt), opts);
  }
}
