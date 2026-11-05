import { execFile } from "node:child_process";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { bundle } from "@remotion/bundler";
import { getVideoMetadata, renderMedia, selectComposition } from "@remotion/renderer";
import { ForgeError } from "@forge/shared";
import { COMPOSITIONS, type CompositionId, type RenderSettings } from "./props.js";
import { findChromiumExecutable } from "./browser.js";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

export interface RenderRemotionOptions {
  composition: CompositionId;
  props: unknown;
  durationSec: number;
  fps?: number;
  width?: number;
  height?: number;
  /** Output .mp4 path; defaults to a temp file. */
  outputPath?: string;
  concurrency?: number;
  onProgress?: (progress: number) => void;
}

export interface RenderRemotionResult {
  outputPath: string;
  sizeBytes: number;
  durationSec: number;
  frames: number;
  fps: number;
  width: number;
  height: number;
  codec: "h264";
  browser: string | null;
}

let bundlePromise: Promise<string> | undefined;

/** Bundle the compositions once per process (webpack via @remotion/bundler). */
export function bundleCompositions(): Promise<string> {
  bundlePromise ??= bundle({
    entryPoint: join(here, "entry.ts"),
    // Our sources import "./x.js" (TS ESM convention); resolve those to .tsx/.ts for webpack.
    webpackOverride: (config) => ({
      ...config,
      resolve: { ...config.resolve, extensionAlias: { ".js": [".tsx", ".ts", ".js"] } },
    }),
  }).catch((e: unknown) => {
    bundlePromise = undefined;
    throw e;
  });
  return bundlePromise;
}

const SettingsSchema = z.object({
  durationSec: z.number().positive().max(600),
  fps: z.number().int().min(1).max(120),
  width: z.number().int().min(16).max(3840).refine((n) => n % 2 === 0, "width must be even for H.264"),
  height: z.number().int().min(16).max(2160).refine((n) => n % 2 === 0, "height must be even for H.264"),
});

/**
 * Render a Remotion composition to an H.264 mp4 locally (bundler + renderer). Uses the preinstalled
 * Chromium (chrome-headless-shell when present) via `browserExecutable`.
 */
export async function renderRemotionVideo(opts: RenderRemotionOptions): Promise<RenderRemotionResult> {
  const schema = COMPOSITIONS[opts.composition];
  if (!schema) throw new ForgeError("BAD_INPUT", `Unknown composition ${String(opts.composition)}`);
  const parsed = schema.safeParse(opts.props);
  if (!parsed.success) throw new ForgeError("BAD_INPUT", `Invalid ${opts.composition} props: ${parsed.error.message}`);
  const render: RenderSettings = SettingsSchema.parse({ durationSec: opts.durationSec, fps: opts.fps ?? 30, width: opts.width ?? 1280, height: opts.height ?? 720 });
  const inputProps = { ...parsed.data, render } as Record<string, unknown>;

  const serveUrl = await bundleCompositions();
  const browser = findChromiumExecutable();
  const browserOpts = browser ? { browserExecutable: browser.path, chromeMode: browser.mode } : {};
  const licenseKey = process.env.REMOTION_LICENSE_KEY || null;

  const composition = await selectComposition({ serveUrl, id: opts.composition, inputProps, ...browserOpts, logLevel: "error" });
  const outputPath = opts.outputPath ?? join(await mkdtemp(join(tmpdir(), "forge-remotion-")), `${opts.composition}.mp4`);
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation: outputPath,
    inputProps,
    ...browserOpts,
    concurrency: opts.concurrency ?? null,
    logLevel: "error",
    licenseKey,
    onProgress: ({ progress }) => opts.onProgress?.(progress),
  });
  const { size } = await stat(outputPath);
  return {
    outputPath,
    sizeBytes: size,
    durationSec: composition.durationInFrames / composition.fps,
    frames: composition.durationInFrames,
    fps: composition.fps,
    width: composition.width,
    height: composition.height,
    codec: "h264",
    browser: browser?.path ?? null,
  };
}

export interface ProbeResult {
  durationSec: number;
  width: number;
  height: number;
  codec: string;
  via: "ffprobe" | "remotion";
}

/** Probe a video with ffprobe when on PATH, else Remotion's getVideoMetadata. */
export async function probeVideo(path: string): Promise<ProbeResult> {
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path]);
    const j = JSON.parse(stdout) as { format: { duration: string }; streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number }> };
    const v = j.streams.find((s) => s.codec_type === "video");
    return { durationSec: Number(j.format.duration), width: v?.width ?? 0, height: v?.height ?? 0, codec: v?.codec_name ?? "unknown", via: "ffprobe" };
  } catch {
    const m = await getVideoMetadata(path);
    return { durationSec: m.durationInSeconds ?? 0, width: m.width, height: m.height, codec: m.codec, via: "remotion" };
  }
}
