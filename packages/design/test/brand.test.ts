import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FigmaRestClient,
  MockFigmaClient,
  brandFromLogo,
  createFigmaClient,
  extractDominantColors,
  figmaKeyFromUrl,
  figmaToBrand,
  hexToOklch,
  importBrand,
  kmeans,
  mergeBrands,
  rgbToOklab,
  type FigmaFile,
} from "../src/index.js";

/** A synthetic logo: 70% transparent, an orange mark, a dark wordmark bar. */
async function logo(): Promise<Buffer> {
  const w = 120, h = 60;
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (x < 40 && y < 40) data.set([255, 102, 0, 255], i);
      else if (y > 48) data.set([20, 20, 28, 255], i);
      else data.set([0, 0, 0, 0], i);
    }
  return sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

const figmaFile: FigmaFile = {
  name: "Acme Brand",
  styles: {
    "S:1": { name: "Brand/Primary", styleType: "FILL" },
    "S:2": { name: "Neutral/Background", styleType: "FILL" },
    "S:3": { name: "Display/H1", styleType: "TEXT" },
    "S:4": { name: "Body/Regular", styleType: "TEXT" },
  },
  document: {
    id: "0:0",
    name: "Doc",
    type: "DOCUMENT",
    children: [
      { id: "1:1", name: "a", type: "RECTANGLE", fills: [{ type: "SOLID", color: { r: 0.1, g: 0.2, b: 0.9, a: 1 } }], styles: { fill: "S:1" } },
      { id: "1:2", name: "b", type: "RECTANGLE", fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }], styles: { fill: "S:2" } },
      { id: "1:3", name: "c", type: "TEXT", style: { fontFamily: "Fraunces", fontWeight: 700, fontSize: 72 }, styles: { text: "S:3" } },
      { id: "1:4", name: "d", type: "TEXT", style: { fontFamily: "Inter", fontWeight: 400, fontSize: 16 }, styles: { text: "S:4" } },
    ],
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("logo colours", () => {
  it("k-means is deterministic and separates clusters", () => {
    const pts = [...Array(30).fill(rgbToOklab({ r: 1, g: 0, b: 0 })), ...Array(10).fill(rgbToOklab({ r: 0, g: 0, b: 1 }))];
    const a = kmeans(pts, 2), b = kmeans(pts, 2);
    expect(a).toEqual(b);
    expect(a.map((c) => c.size).sort((x, y) => x - y)).toEqual([10, 30]);
  });

  it("extracts dominant colours with sharp, ignoring transparency", async () => {
    const clusters = await extractDominantColors(await logo(), 3);
    expect(clusters.reduce((s, c) => s + c.share, 0)).toBeCloseTo(1, 5);
    const orange = clusters.find((c) => Math.abs(c.h - hexToOklch("#ff6600").h) < 10 && c.c > 0.1);
    expect(orange).toBeDefined();
    const brand = await brandFromLogo(await logo());
    expect(brand.source).toBe("logo");
    expect(Math.abs(hexToOklch(brand.colors.primary!).h - hexToOklch("#ff6600").h)).toBeLessThan(10);
  });
});

describe("figma", () => {
  it("maps colour + text styles to brand roles", () => {
    const b = figmaToBrand(figmaFile);
    expect(b.colors.primary).toBe("#1a33e6");
    expect(b.colors.background).toBe("#ffffff");
    expect(b.fonts).toEqual({ display: "Fraunces", body: "Inter" });
    expect(b.source).toBe("figma");
  });

  it("REST adapter calls GET /v1/files/:key with X-Figma-Token", async () => {
    const calls: Array<{ url: string; token: string | null }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, token: new Headers(init.headers).get("X-Figma-Token") });
      if (url.endsWith("/styles")) return new Response(JSON.stringify({ meta: { styles: [] } }), { status: 200 });
      return new Response(JSON.stringify(figmaFile), { status: 200 });
    });
    const client = new FigmaRestClient("tok_test", "https://api.figma.test");
    const file = await client.getFile("AbC123");
    expect(file.name).toBe("Acme Brand");
    expect(calls[0]).toEqual({ url: "https://api.figma.test/v1/files/AbC123", token: "tok_test" });
    expect(calls[1]!.url).toBe("https://api.figma.test/v1/files/AbC123/styles");
  });

  it("REST adapter resolves published styles via /nodes and reports errors", async () => {
    const tree: FigmaFile = { name: "Lib", styles: {}, document: { id: "0:0", name: "Doc", type: "DOCUMENT", children: [] } };
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/nodes?ids=")) {
        return new Response(JSON.stringify({ nodes: { "9:1": { document: { id: "9:1", name: "swatch", type: "RECTANGLE", fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }] } } } }), { status: 200 });
      }
      if (url.endsWith("/styles")) return new Response(JSON.stringify({ meta: { styles: [{ node_id: "9:1", name: "Primary", style_type: "FILL", key: "k1" }] } }), { status: 200 });
      return new Response(JSON.stringify(tree), { status: 200 });
    });
    const b = figmaToBrand(await new FigmaRestClient("t", "https://x").getFile("Key1"));
    expect(b.colors.primary).toBe("#ff0000");
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 403 }));
    await expect(new FigmaRestClient("t", "https://x").getFile("Key1")).rejects.toThrow(/403/);
    await expect(new FigmaRestClient("", "https://x").getFile("Key1")).rejects.toThrow(/FIGMA_TOKEN/);
    await expect(new FigmaRestClient("t", "https://x").getFile("../etc")).rejects.toThrow(/Invalid/);
  });

  it("mock adapter is selected by default and is labeled", async () => {
    vi.stubEnv("FIGMA_PROVIDER", "");
    const c = createFigmaClient();
    expect(c.isMock).toBe(true);
    expect(c).toBeInstanceOf(MockFigmaClient);
    const f = await c.getFile("demo");
    expect(f.name).toMatch(/^Mock Figma file/);
    expect(figmaToBrand(f).colors.primary).toMatch(/^#/);
    vi.stubEnv("FIGMA_PROVIDER", "figma");
    expect(createFigmaClient()).toBeInstanceOf(FigmaRestClient);
    expect(figmaKeyFromUrl("https://www.figma.com/design/AbCd123/My-File?node-id=1")).toBe("AbCd123");
  });
});

describe("importBrand", () => {
  it("merges logo < figma < explicit", async () => {
    const figma = new MockFigmaClient().addFile("K1", figmaFile);
    const b = await importBrand({ logo: await logo(), figma: "K1", explicit: { colors: { primary: "#00aa55" } } }, { figma });
    expect(b.colors.primary).toBe("#00aa55");
    expect(b.colors.background).toBe("#ffffff");
    expect(b.fonts.display).toBe("Fraunces");
    expect(b.source).toBe("merged");
    expect(mergeBrands({ colors: { primary: "#111111" } }).source).toBe("explicit");
  });
});
