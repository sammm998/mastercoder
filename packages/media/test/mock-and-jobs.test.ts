import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EventBus, LocalObjectStore, MemoryUsageSink } from "@forge/shared";
import {
  MediaJobService,
  MockMediaProvider,
  generateImageSet,
  generateLogo,
  hasFfmpeg,
  readPngText,
  styleFromBrand,
  wordmarkSvg,
  pngsToIco,
  type MediaProvider,
} from "../src/index.js";

const brand = { palette: { bg: "#0f172a", accent: "#f97316", text: "#f8fafc", accent2: "#22d3ee" }, mood: "bold and optimistic", fontFamily: "Space Grotesk" };

describe("MockMediaProvider (real local rendering)", () => {
  const mock = new MockMediaProvider();

  it("renders deterministic, tagged PNGs from prompt hash + palette", async () => {
    const a = await mock.textToImage({ prompt: "mountain lake", width: 320, height: 200, n: 2, palette: ["#112233", "#ff8800"] });
    const b = await mock.textToImage({ prompt: "mountain lake", width: 320, height: 200, n: 2, palette: ["#112233", "#ff8800"] });
    expect(a.items).toHaveLength(2);
    expect(Buffer.from(a.items[0]!.bytes!).equals(Buffer.from(b.items[0]!.bytes!))).toBe(true);
    expect(Buffer.from(a.items[0]!.bytes!).equals(Buffer.from(a.items[1]!.bytes!))).toBe(false);
    const meta = await sharp(a.items[0]!.bytes!).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["png", 320, 200]);
    expect(readPngText(a.items[0]!.bytes!)["forge:mock"]).toBe("true");
    expect(a.items[0]!.meta?.mock).toBe(true);
    expect(a.costUsd).toBe(0);
    expect(mock.estimate({ type: "text-to-image", prompt: "x", width: 64, height: 64, n: 1 }).highUsd).toBe(0);
  });

  it("removes a flat background with a luminance key (alpha channel)", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#ffffff"/><circle cx="50" cy="50" r="25" fill="#000000"/></svg>`;
    const src = new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
    const r = await mock.removeBackground({ image: src });
    const { data, info } = await sharp(r.items[0]!.bytes!).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    expect(data[3]).toBe(0); // corner transparent
    expect(data[(50 * 100 + 50) * 4 + 3]).toBe(255); // centre opaque
    expect(r.items[0]!.meta?.method).toBe("luminance-key");
  });

  it("upscales with a real resize", async () => {
    const src = (await mock.textToImage({ prompt: "x", width: 100, height: 60, n: 1 })).items[0]!.bytes!;
    const r = await mock.upscale({ image: `data:image/png;base64,${Buffer.from(src).toString("base64")}`, scale: 2.5 });
    const m = await sharp(r.items[0]!.bytes!).metadata();
    expect([m.width, m.height]).toEqual([250, 150]);
  });

  it("edits with a mask (only masked area changes)", async () => {
    const src = new Uint8Array(await sharp({ create: { width: 40, height: 40, channels: 3, background: "#808080" } }).png().toBuffer());
    const maskSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#000"/><rect x="20" width="20" height="40" fill="#fff"/></svg>`;
    const mask = new Uint8Array(await sharp(Buffer.from(maskSvg)).png().toBuffer());
    const r = await mock.editImage({ image: src, mask, prompt: "paint it orange" });
    const { data } = await sharp(r.items[0]!.bytes!).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    expect([data[0], data[1], data[2]]).toEqual([128, 128, 128]); // left (unmasked) untouched
    const right = (10 * 40 + 30) * 3;
    expect([data[right], data[right + 1], data[right + 2]]).not.toEqual([128, 128, 128]);
  });

  it(`renders a video (${hasFfmpeg() ? "mp4 via ffmpeg" : "animated webp via sharp"})`, async () => {
    const r = await mock.textToVideo({ prompt: "city at night", durationSec: 1, aspectRatio: "16:9" });
    const item = r.items[0]!;
    expect(item.bytes!.byteLength).toBeGreaterThan(1000);
    expect(item.mimeType).toBe(hasFfmpeg() ? "video/mp4" : "image/webp");
    expect(item.durationSec).toBeCloseTo(1, 1);
    expect(item.meta?.renderer).toBeTypeOf("string");
  });

  it("falls back to animated WebP when forced", async () => {
    const r = await new MockMediaProvider({ videoFormat: "webp", fps: 4 }).imageToVideo({
      image: (await mock.textToImage({ prompt: "x", width: 120, height: 80, n: 1 })).items[0]!.bytes!,
      prompt: "slow zoom",
      durationSec: 1,
    });
    const m = await sharp(r.items[0]!.bytes!, { animated: true }).metadata();
    expect(m.format).toBe("webp");
    expect(m.pages).toBe(4);
  });
});

describe("brand style + logos", () => {
  it("shares a seed and style suffix across an image set", async () => {
    const style = styleFromBrand(brand);
    expect(style.palette).toEqual(["#0f172a", "#f97316", "#f8fafc", "#22d3ee"]);
    expect(style.suffix).toContain("bold and optimistic");
    expect(styleFromBrand(brand).seed).toBe(style.seed);
    const mock = new MockMediaProvider();
    const set = await generateImageSet(mock, { prompts: ["hero image", "team photo", "product shot"], brand, n: 1, width: 128, height: 128 });
    expect(set.results).toHaveLength(3);
    const seeds = (mock.calls.filter((c) => c.method === "textToImage").map((c) => (c.input as { seed: number }).seed));
    expect(new Set(seeds).size).toBe(1);
  });

  it("blocks an image set before any provider call when a prompt is disallowed", async () => {
    const mock = new MockMediaProvider();
    await expect(generateImageSet(mock, { prompts: ["fine", "ISIS recruitment poster"], brand, n: 1 })).rejects.toMatchObject({ code: "MODERATION_BLOCKED" });
    expect(mock.calls).toHaveLength(0);
  });

  it("generates logo sizes, favicon and an SVG wordmark", async () => {
    const r = await generateLogo(new MockMediaProvider(), { name: "Northwind", brand, tagline: "Coffee roasters" });
    for (const s of [512, 192, 180, 32, 16]) {
      const m = await sharp(r.sizes[s]!).metadata();
      expect([m.width, m.height, m.hasAlpha]).toEqual([s, s, true]);
    }
    expect(Buffer.from(r.faviconIco.subarray(0, 4)).toString("hex")).toBe("00000100");
    expect(Buffer.from(r.faviconIco).readUInt16LE(4)).toBe(3);
    expect(r.wordmarkSvg).toContain("Space Grotesk");
    expect(r.wordmarkSvg).toContain(">Northwind<");
    const svgPng = await sharp(Buffer.from(r.wordmarkSvg)).png().toBuffer();
    expect(svgPng.byteLength).toBeGreaterThan(500);
    expect(r.models).toEqual(["mock-composition-v1", "mock-luminance-key-v1"]);
  });

  it("blocks brand-impersonating logos", async () => {
    await expect(generateLogo(new MockMediaProvider(), { name: "PayPal", brand })).rejects.toMatchObject({ code: "MODERATION_BLOCKED" });
  });

  it("escapes XML in wordmarks and builds ICO directories", () => {
    expect(wordmarkSvg({ name: "A&B <x>", palette: ["#000000", "#ff0000"] })).toContain("A&amp;B &lt;x&gt;");
    const ico = pngsToIco([{ size: 16, png: new Uint8Array(10) }]);
    expect(ico.byteLength).toBe(6 + 16 + 10);
  });
});

describe("MediaJobService", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-media-test-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function setup(provider: MediaProvider = new MockMediaProvider()) {
    const store = new LocalObjectStore(dir);
    const sink = new MemoryUsageSink();
    const events = new EventBus();
    return { svc: new MediaJobService({ provider, store, sink, events }), store, sink, events, provider };
  }

  it("runs an image job: stores artifacts, records usage, emits events", async () => {
    const { svc, store, sink, events } = setup();
    const arts = await svc.run({ type: "text-to-image", prompt: "a child playing in a park", width: 256, height: 256, n: 2 }, { projectId: "prj_1", taskId: "tsk_1" });
    expect(arts).toHaveLength(2);
    for (const a of arts) {
      expect(a.kind).toBe("image");
      expect(a.storageKey).toBe(`projects/prj_1/media/${a.id}.png`);
      expect(await store.exists(a.storageKey)).toBe(true);
      expect(a.meta).toMatchObject({ mock: true, provider: "mock", width: 256, height: 256 });
    }
    expect(sink.records).toEqual([expect.objectContaining({ kind: "image_count", quantity: 2, costUsd: 0, provider: "mock", projectId: "prj_1", taskId: "tsk_1" })]);
    const prog = events.ofType("job.progress").map((e) => e.progress);
    expect(prog[0]).toBe(0);
    expect(prog.at(-1)).toBe(1);
    expect([...prog].sort((x, y) => x - y)).toEqual(prog);
    expect(events.ofType("artifact.ready").map((e) => e.artifactId)).toEqual(arts.map((a) => a.id));
  });

  it("blocks disallowed jobs before calling the provider", async () => {
    const provider = new MockMediaProvider();
    const spy = vi.spyOn(provider, "textToImage");
    const { svc, sink, events } = setup(provider);
    await expect(svc.run({ type: "text-to-image", prompt: "Taylor Swift nude", width: 256, height: 256, n: 1 }, { projectId: "prj_1" })).rejects.toMatchObject({
      code: "MODERATION_BLOCKED",
      details: expect.objectContaining({ category: "deepfake" }),
    });
    expect(spy).not.toHaveBeenCalled();
    expect(sink.records).toHaveLength(0);
    expect(events.ofType("task.failed")[0]).toMatchObject({ charged: false, blockedOn: "deepfake" });
  });

  it("records media_seconds for video jobs and downloads URL-only results", async () => {
    const png = (await new MockMediaProvider().textToImage({ prompt: "x", width: 64, height: 64, n: 1 })).items[0]!.bytes!;
    const fake: MediaProvider = {
      ...new MockMediaProvider(),
      name: "stub",
      isMock: false,
      estimate: () => ({ lowUsd: 0.5, highUsd: 0.5, breakdown: [] }),
      imageToVideo: async () => ({ items: [{ url: "https://cdn.test/v.mp4", mimeType: "video/mp4", durationSec: 5 }], costUsd: 0.35, provider: "stub", model: "stub-video" }),
    } as unknown as MediaProvider;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]), { status: 200 })));
    try {
      const { svc, sink } = setup(fake);
      const arts = await svc.run({ type: "image-to-video", image: png, prompt: "zoom in", durationSec: 5 }, { projectId: "prj_2" });
      expect(arts[0]).toMatchObject({ kind: "video", mimeType: "video/mp4", costUsd: 0.35 });
      expect(arts[0]!.storageKey).toMatch(/^projects\/prj_2\/media\/art_.*\.mp4$/);
      expect(sink.records[0]).toMatchObject({ kind: "media_seconds", quantity: 5, costUsd: 0.35, provider: "stub" });
      expect(svc.estimate({ type: "image-to-video", image: png, prompt: "zoom", durationSec: 5 }).highUsd).toBe(0.5);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects invalid jobs as BAD_INPUT", async () => {
    const { svc } = setup();
    await expect(svc.run({ type: "text-to-image", prompt: "", width: 1, height: 1, n: 0 } as never, { projectId: "p" })).rejects.toMatchObject({ code: "BAD_INPUT" });
  });
});
