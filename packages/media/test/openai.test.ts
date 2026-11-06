import { describe, expect, it, vi } from "vitest";
import { OpenAIMediaProvider, imageSize, videoSeconds } from "../src/index.js";

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

describe("OpenAIMediaProvider (stubbed fetch)", () => {
  it("generates images with gpt-image-1 at the closest size and decodes base64", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetch = vi.fn(async (u: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(u), body: JSON.parse(String(init?.body)) });
      return json({ data: [{ b64_json: Buffer.from(png).toString("base64") }] });
    });
    const p = new OpenAIMediaProvider({ apiKey: "sk-test", fetch: fetch as unknown as typeof globalThis.fetch });
    const r = await p.textToImage({ prompt: "hero photo of a hair salon", width: 1600, height: 900, n: 1, style: "warm" });
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/images/generations");
    expect(calls[0]!.body).toMatchObject({ model: "gpt-image-1", size: "1536x1024", n: 1, prompt: "hero photo of a hair salon. Style: warm" });
    expect(r.items[0]).toMatchObject({ mimeType: "image/png", width: 1536, height: 1024 });
    expect(r.costUsd).toBeCloseTo(0.063);
    expect(p.estimate({ type: "text-to-image", prompt: "x", width: 1024, height: 1024, n: 2 }).highUsd).toBeGreaterThan(0.1);
  });

  it("creates a Sora video, polls until completed and downloads the mp4", async () => {
    let polls = 0;
    const urls: string[] = [];
    const fetch = vi.fn(async (u: string | URL | Request) => {
      const url = String(u);
      urls.push(url);
      if (url.endsWith("/videos")) return json({ id: "vid_1", status: "queued" });
      if (url.endsWith("/content")) return new Response(Uint8Array.from([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70]));
      return json({ id: "vid_1", status: ++polls < 2 ? "in_progress" : "completed", progress: 50 });
    });
    const p = new OpenAIMediaProvider({ apiKey: "sk-test", fetch: fetch as unknown as typeof globalThis.fetch, pollIntervalMs: 1 });
    const r = await p.textToVideo({ prompt: "slow pan across a café", durationSec: 6, aspectRatio: "16:9" });
    expect(urls.at(-1)).toBe("https://api.openai.com/v1/videos/vid_1/content");
    expect(r.items[0]).toMatchObject({ mimeType: "video/mp4", durationSec: 8 });
    expect(r.costUsd).toBeCloseTo(0.8);
  });

  it("maps sizes and clip lengths", () => {
    expect(imageSize(900, 1600)).toBe("1024x1536");
    expect(imageSize(1000, 1000)).toBe("1024x1024");
    expect([videoSeconds(3), videoSeconds(5), videoSeconds(30)]).toEqual([4, 8, 12]);
  });
});

describe("OpenAI image model fallback", () => {
  it("falls back to the next model when the key has no access to the configured one", async () => {
    const tried: string[] = [];
    const fetch = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      const model = JSON.parse(String(init?.body)).model as string;
      tried.push(model);
      if (model !== "dall-e-3") return new Response(JSON.stringify({ error: { message: `The model '${model}' does not exist.` } }), { status: 400 });
      return json({ data: [{ b64_json: Buffer.from(png).toString("base64") }] });
    });
    const p = new OpenAIMediaProvider({ apiKey: "sk-test", fetch: fetch as unknown as typeof globalThis.fetch });
    const r = await p.textToImage({ prompt: "x", width: 1536, height: 1024, n: 1 });
    expect(tried).toEqual(["gpt-image-1", "gpt-image-2", "gpt-image-1.5", "gpt-image-1-mini", "dall-e-3"]);
    expect(r.model).toBe("dall-e-3");
    await p.textToImage({ prompt: "y", width: 1024, height: 1024, n: 1 });
    expect(tried.at(-1)).toBe("dall-e-3");
    expect(tried).toHaveLength(6);
  });
});
