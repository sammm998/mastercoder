import { afterEach, describe, expect, it, vi } from "vitest";
import { FalMediaProvider, ReplicateMediaProvider, closestAspect, createMediaProvider, MockMediaProvider, priceFor, costForUnits, megapixels, videoDuration } from "../src/index.js";

type Call = { url: string; init?: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Scripted fetch: each matcher returns a response; calls are recorded. */
function scriptedFetch(routes: Array<[RegExp, (call: Call) => Response]>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    const r = routes.find(([rx]) => rx.test(url));
    if (!r) throw new Error(`unexpected fetch ${url}`);
    return r[1]({ url, init });
  });
  return { fn, calls };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("FalMediaProvider (queue API, stubbed fetch)", () => {
  it("submits, polls status and fetches the response for text-to-image", async () => {
    let polls = 0;
    const { fn, calls } = scriptedFetch([
      [/queue\.fal\.run\/fal-ai\/flux\/dev$/, () => jsonResponse({ request_id: "req1", status_url: "https://queue.fal.run/fal-ai/flux/requests/req1/status", response_url: "https://queue.fal.run/fal-ai/flux/requests/req1" })],
      [/requests\/req1\/status$/, () => jsonResponse(polls++ === 0 ? { status: "IN_QUEUE", queue_position: 2 } : { status: "COMPLETED" })],
      [/requests\/req1$/, () => jsonResponse({ images: [{ url: "https://fal.media/a.png", width: 1024, height: 1024, content_type: "image/png" }, { url: "https://fal.media/b.png", width: 1024, height: 1024 }], seed: 7 })],
    ]);
    vi.stubGlobal("fetch", fn);
    const progress: string[] = [];
    const fal = new FalMediaProvider({ apiKey: "test-key", pollIntervalMs: 1 });
    const r = await fal.textToImage({ prompt: "a fox", width: 1024, height: 1024, n: 2, seed: 7, style: "flat vector" }, { onProgress: (_p, l) => progress.push(l ?? "") });
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({ url: "https://fal.media/a.png", mimeType: "image/png", width: 1024 });
    expect(r.model).toBe("fal-ai/flux/dev");
    // 2 images x ceil(1.048576 MP)=2 MP each x $0.025
    expect(r.costUsd).toBeCloseTo(0.1, 6);
    const submit = calls[0]!;
    expect((submit.init?.headers as Record<string, string>).Authorization).toBe("Key test-key");
    const body = JSON.parse(String(submit.init?.body));
    expect(body).toMatchObject({ prompt: "a fox, flat vector", image_size: { width: 1024, height: 1024 }, num_images: 2, seed: 7 });
    expect(progress.some((l) => l.includes("position 2"))).toBe(true);
  });

  it("uses aliases, video duration snapping and audio-off Veo pricing", async () => {
    const { fn, calls } = scriptedFetch([
      [/queue\.fal\.run\/fal-ai\/veo3\.1\/fast$/, () => jsonResponse({ request_id: "v1" })],
      [/requests\/v1\/status$/, () => jsonResponse({ status: "COMPLETED" })],
      [/requests\/v1$/, () => jsonResponse({ video: { url: "https://fal.media/v.mp4", content_type: "video/mp4" } })],
    ]);
    vi.stubGlobal("fetch", fn);
    const fal = new FalMediaProvider({ apiKey: "k", pollIntervalMs: 1 });
    const r = await fal.textToVideo({ prompt: "waves", durationSec: 5, aspectRatio: "1:1" });
    expect(JSON.parse(String(calls[0]!.init?.body))).toMatchObject({ duration: "6s", aspect_ratio: "16:9", generate_audio: false });
    expect(r.items[0]).toMatchObject({ durationSec: 6, mimeType: "video/mp4" });
    expect(r.costUsd).toBeCloseTo(0.6, 6);
    expect(videoDuration("fal-ai/kling-video/v2.5-turbo/pro/text-to-video", 7)).toEqual({ seconds: 10, param: "10" });
  });

  it("raises PROVIDER_ERROR on HTTP errors and requires FAL_KEY", async () => {
    vi.stubGlobal("fetch", scriptedFetch([[/queue/, () => new Response("nope", { status: 401 })]]).fn);
    await expect(new FalMediaProvider({ apiKey: "bad" }).removeBackground({ image: "https://x.test/a.png" })).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    vi.stubEnv("FAL_KEY", "");
    await expect(new FalMediaProvider().upscale({ image: "https://x.test/a.png", scale: 2 })).rejects.toMatchObject({ code: "BAD_INPUT" });
  });

  it("sends bytes as data URIs and routes masks to the fill model", async () => {
    const { fn, calls } = scriptedFetch([
      [/fal-ai\/flux-pro\/v1\/fill$/, () => jsonResponse({ request_id: "e1" })],
      [/e1\/status$/, () => jsonResponse({ status: "COMPLETED" })],
      [/e1$/, () => jsonResponse({ images: [{ url: "https://fal.media/e.png", width: 1024, height: 1024 }] })],
    ]);
    vi.stubGlobal("fetch", fn);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const r = await new FalMediaProvider({ apiKey: "k", pollIntervalMs: 1 }).editImage({ image: png, mask: png, prompt: "add a hat" });
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.image_url).toMatch(/^data:image\/png;base64,/);
    expect(body.mask_url).toMatch(/^data:image\/png;base64,/);
    expect(r.costUsd).toBeCloseTo(0.1, 6); // 2 MP x $0.05
  });

  it("estimates from the price table", () => {
    const fal = new FalMediaProvider({ apiKey: "k" });
    const e = fal.estimate({ type: "text-to-image", prompt: "x", width: 1024, height: 1024, n: 4, model: "schnell" });
    expect(e.breakdown[0]!.usd).toBeCloseTo(0.024, 6); // 4 images x 2 MP x $0.003
    expect(e.lowUsd).toBeLessThan(e.highUsd);
    const v = fal.estimate({ type: "image-to-video", prompt: "x", image: "https://a.test/i.png", durationSec: 10 });
    expect(v.breakdown[0]!.usd).toBeCloseTo(0.35 + 5 * 0.07, 6);
  });
});

describe("ReplicateMediaProvider (predictions API, stubbed fetch)", () => {
  it("creates a prediction, polls urls.get and returns outputs", async () => {
    let n = 0;
    const { fn, calls } = scriptedFetch([
      [/models\/black-forest-labs\/flux-schnell\/predictions$/, () => jsonResponse({ id: "p1", status: "starting", urls: { get: "https://api.replicate.com/v1/predictions/p1" } }, 201)],
      [/predictions\/p1$/, () => jsonResponse(n++ === 0 ? { id: "p1", status: "processing" } : { id: "p1", status: "succeeded", output: ["https://replicate.delivery/a.png", "https://replicate.delivery/b.png"] })],
    ]);
    vi.stubGlobal("fetch", fn);
    const rep = new ReplicateMediaProvider({ apiToken: "r8_test", pollIntervalMs: 1 });
    const r = await rep.textToImage({ prompt: "a fox", width: 1344, height: 768, n: 2, model: "schnell" });
    expect(r.items.map((i) => i.url)).toEqual(["https://replicate.delivery/a.png", "https://replicate.delivery/b.png"]);
    expect(r.costUsd).toBeCloseTo(0.006, 6);
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe("Bearer r8_test");
    expect(JSON.parse(String(calls[0]!.init?.body)).input).toMatchObject({ aspect_ratio: "16:9", num_outputs: 2 });
  });

  it("supports owner/name:version ids and surfaces failures", async () => {
    const { fn, calls } = scriptedFetch([[/\/v1\/predictions$/, () => jsonResponse({ id: "p2", status: "failed", error: "NSFW content detected" })]]);
    vi.stubGlobal("fetch", fn);
    const rep = new ReplicateMediaProvider({ apiToken: "t", pollIntervalMs: 1 });
    await expect(rep.upscale({ image: "https://a.test/x.png", scale: 2, model: "nightmareai/real-esrgan:abc123" })).rejects.toThrow(/NSFW content detected/);
    expect(JSON.parse(String(calls[0]!.init?.body))).toMatchObject({ version: "abc123" });
  });

  it("maps aspect ratios", () => {
    expect(closestAspect(1024, 1024)).toBe("1:1");
    expect(closestAspect(1080, 1920)).toBe("9:16");
    expect(closestAspect(1200, 900)).toBe("4:3");
  });
});

describe("pricing + factory", () => {
  it("prices per megapixel, image and second with base blocks", () => {
    expect(megapixels(1024, 1024)).toBe(2);
    expect(megapixels(1000, 1000, 3)).toBe(3);
    expect(costForUnits(priceFor("fal-ai/flux/schnell"), 2)).toBeCloseTo(0.006, 6);
    expect(costForUnits(priceFor("fal-ai/kling-video/v2.5-turbo/pro/text-to-video"), 5)).toBeCloseTo(0.35, 6);
    expect(() => priceFor("unknown/model")).toThrow(/No media price/);
  });

  it("applies MEDIA_PRICE_OVERRIDES", () => {
    vi.stubEnv("MEDIA_PRICE_OVERRIDES", JSON.stringify({ "fal-ai/flux/dev": 0.03 }));
    expect(priceFor("fal-ai/flux/dev").usd).toBe(0.03);
  });

  it("selects adapters by MEDIA_PROVIDER", () => {
    vi.stubEnv("MEDIA_PROVIDER", "");
    expect(createMediaProvider()).toBeInstanceOf(MockMediaProvider);
    vi.stubEnv("MEDIA_PROVIDER", "fal");
    expect(createMediaProvider()).toBeInstanceOf(FalMediaProvider);
    vi.stubEnv("MEDIA_PROVIDER", "replicate");
    expect(createMediaProvider()).toBeInstanceOf(ReplicateMediaProvider);
    vi.stubEnv("MEDIA_PROVIDER", "nope");
    expect(() => createMediaProvider()).toThrow(/Unknown MEDIA_PROVIDER/);
  });
});
