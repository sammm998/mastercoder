import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { MockMediaProvider } from "../src/index.js";
import { DEFAULT_VIDEO_THEME, findChromiumExecutable, probeVideo, renderRemotionVideo } from "../src/remotion/index.js";

describe("Remotion programmatic video (real render)", () => {
  it("finds the preinstalled Chromium", () => {
    const b = findChromiumExecutable();
    expect(b).not.toBeNull();
    expect(existsSync(b!.path)).toBe(true);
  });

  it("renders a 3-second ProductDemo mp4 from a generated screenshot", async () => {
    // Screenshot generated locally by the mock provider (sharp composition), passed as a data URI.
    const shot = await new MockMediaProvider().textToImage({ prompt: "Dashboard screenshot with charts and a sidebar", width: 1280, height: 800, n: 1 });
    const src = `data:image/png;base64,${Buffer.from(shot.items[0]!.bytes!).toString("base64")}`;
    const progress: number[] = [];
    const out = await renderRemotionVideo({
      composition: "ProductDemo",
      props: { theme: DEFAULT_VIDEO_THEME, title: "Forge demo", device: "laptop", screenshots: [{ src, caption: "Your dashboard, generated" }] },
      durationSec: 3,
      fps: 30,
      width: 1280,
      height: 720,
      onProgress: (p) => progress.push(p),
    });
    try {
      expect(existsSync(out.outputPath)).toBe(true);
      expect(out.sizeBytes).toBeGreaterThan(20_000);
      expect(out.frames).toBe(90);
      const probe = await probeVideo(out.outputPath);
      expect(probe.codec).toBe("h264");
      expect(probe.width).toBe(1280);
      expect(probe.height).toBe(720);
      expect(probe.durationSec).toBeGreaterThan(2.8);
      expect(probe.durationSec).toBeLessThan(3.3);
      expect(progress.at(-1)).toBe(1);
    } finally {
      await rm(dirname(out.outputPath), { recursive: true, force: true });
    }
  });

  it("renders Explainer and AnimatedText compositions", async () => {
    for (const [composition, props] of [
      ["Explainer", { theme: DEFAULT_VIDEO_THEME, title: "How Forge works", sections: [{ heading: "Plan", bullets: ["Brief", "Spec"] }, { heading: "Build", bullets: ["Code", "Test"] }] }],
      ["AnimatedText", { theme: DEFAULT_VIDEO_THEME, lines: ["Build faster", "Ship safer"], animation: "typewriter" }],
    ] as const) {
      const out = await renderRemotionVideo({ composition, props, durationSec: 2, fps: 15, width: 640, height: 360 });
      const probe = await probeVideo(out.outputPath);
      expect(probe.durationSec).toBeGreaterThan(1.8);
      expect(probe.width).toBe(640);
      await rm(dirname(out.outputPath), { recursive: true, force: true });
    }
  });

  it("rejects invalid props", async () => {
    await expect(renderRemotionVideo({ composition: "ProductDemo", props: { title: "x" }, durationSec: 1 })).rejects.toThrow(/Invalid ProductDemo props/);
  });
});
