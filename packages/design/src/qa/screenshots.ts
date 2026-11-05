import { mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import type { Screenshot } from "../types.js";
import { openPage } from "./heuristic.js";

export interface CaptureOptions {
  /** Directory for PNGs and videos (omit to keep PNGs in memory only and skip video). */
  outDir?: string;
  /** Record a short scroll video (webm) at these viewport widths (default: the largest). */
  videoAt?: number[];
  browser?: Browser;
  timeoutMs?: number;
  settleMs?: number;
}

const heightFor = (w: number) => (w <= 480 ? 812 : w <= 1024 ? 1024 : 900);

/**
 * Full-page PNG screenshots at each viewport width (after a scroll pass so scroll-triggered content has
 * revealed), plus a short scroll-through video via Playwright recordVideo.
 */
export async function captureScreenshots(url: string, viewports: number[] = [375, 768, 1440], opts: CaptureOptions = {}): Promise<Screenshot[]> {
  const browser = opts.browser ?? (await chromium.launch());
  const videoAt = new Set(opts.outDir ? (opts.videoAt ?? [Math.max(...viewports)]) : []);
  if (opts.outDir) await mkdir(opts.outDir, { recursive: true });
  const shots: Screenshot[] = [];
  try {
    for (const width of viewports) {
      const height = heightFor(width);
      const mobile = width <= 480;
      const videoDir = videoAt.has(width) && opts.outDir ? join(opts.outDir, `video-${width}`) : undefined;
      const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 1,
        isMobile: mobile,
        hasTouch: mobile,
        ...(videoDir ? { recordVideo: { dir: videoDir, size: { width: Math.min(width, 1280), height: Math.round((Math.min(width, 1280) / width) * height) } } } : {}),
      });
      try {
        const page = await openPage(context, url, opts.timeoutMs ?? 45_000, opts.settleMs ?? 1200);
        const png = await page.screenshot({ fullPage: true, type: "png", animations: "disabled" });
        const path = opts.outDir ? join(opts.outDir, `shot-${width}.png`) : undefined;
        if (path) {
          const { writeFile } = await import("node:fs/promises");
          await writeFile(path, png);
        }
        shots.push({ viewport: width, width, height, png, ...(path ? { path } : {}) });
      } finally {
        await context.close();
      }
      if (videoDir) {
        const files = (await readdir(videoDir)).filter((f) => f.endsWith(".webm"));
        if (files[0]) {
          const target = join(opts.outDir!, `scroll-${width}.webm`);
          await rename(join(videoDir, files[0]), target);
          shots[shots.length - 1]!.videoPath = target;
        }
      }
    }
  } finally {
    if (!opts.browser) await browser.close();
  }
  return shots;
}
