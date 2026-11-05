import { ForgeError, selectAdapter } from "@forge/shared";
import { FigmaFileSchema, type FigmaClient, type FigmaFile, type FigmaNode } from "../brand/figma.js";
import { hashString } from "../curated.js";
import { hexToRgb, oklchToHex } from "../color.js";

/**
 * Real adapter: Figma REST API. `GET /v1/files/:key` returns the document tree plus the file's local
 * `styles` map; style values are resolved from the nodes that reference them. Published library styles
 * (`GET /v1/files/:key/styles`) whose nodes are not in the tree are fetched with `GET /v1/files/:key/nodes`.
 * Auth: personal access token in FIGMA_TOKEN (header `X-Figma-Token`). Figma API calls are not billed.
 */
export class FigmaRestClient implements FigmaClient {
  readonly name = "figma";
  readonly isMock = false;
  constructor(
    private readonly token = process.env.FIGMA_TOKEN ?? "",
    private readonly baseUrl = process.env.FIGMA_API_URL ?? "https://api.figma.com",
  ) {}

  private async get(path: string): Promise<unknown> {
    if (!this.token) throw new ForgeError("UNAUTHORIZED", "FIGMA_TOKEN is not set");
    const res = await fetch(`${this.baseUrl}${path}`, { headers: { "X-Figma-Token": this.token } });
    if (!res.ok) throw new ForgeError("PROVIDER_ERROR", `Figma ${path} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  async getFile(fileKey: string): Promise<FigmaFile> {
    if (!/^[A-Za-z0-9]+$/.test(fileKey)) throw new ForgeError("BAD_INPUT", "Invalid Figma file key");
    const file = FigmaFileSchema.parse(await this.get(`/v1/files/${fileKey}`));
    // Library styles published from this file: add their nodes when missing from the tree walk.
    try {
      const pub = (await this.get(`/v1/files/${fileKey}/styles`)) as { meta?: { styles?: Array<{ node_id: string; name: string; style_type: string; key: string }> } };
      const styles = pub.meta?.styles ?? [];
      const known = new Set<string>();
      const walk = (n: FigmaNode) => { known.add(n.id); n.children?.forEach(walk); };
      walk(file.document);
      const missing = styles.filter((s) => !known.has(s.node_id)).slice(0, 200);
      if (missing.length) {
        const nodes = (await this.get(`/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(missing.map((s) => s.node_id).join(","))}`)) as {
          nodes?: Record<string, { document?: FigmaNode } | null>;
        };
        const extra: FigmaNode[] = [];
        for (const s of missing) {
          const doc = nodes.nodes?.[s.node_id]?.document;
          if (!doc) continue;
          const styleId = `pub:${s.key}`;
          file.styles[styleId] = { key: s.key, name: s.name, styleType: s.style_type };
          extra.push({ ...doc, styles: { ...(doc.styles ?? {}), [s.style_type === "TEXT" ? "text" : "fill"]: styleId } });
        }
        file.document = { ...file.document, children: [...(file.document.children ?? []), ...extra] };
      }
    } catch (e) {
      if (e instanceof ForgeError && e.code === "UNAUTHORIZED") throw e;
      // Published-styles lookup is best effort (404 for files without published styles).
    }
    return file;
  }
}

/**
 * Mock adapter (clearly labeled, deterministic): returns files registered via `addFile`, or a generated
 * sample file named "Mock Figma file <key>" whose style values are derived from a hash of the key.
 * It never contacts Figma.
 */
export class MockFigmaClient implements FigmaClient {
  readonly name = "mock";
  readonly isMock = true;
  private readonly files = new Map<string, FigmaFile>();
  addFile(key: string, file: FigmaFile): this {
    this.files.set(key, FigmaFileSchema.parse(file));
    return this;
  }
  async getFile(fileKey: string): Promise<FigmaFile> {
    const f = this.files.get(fileKey);
    if (f) return f;
    const h = hashString(fileKey) % 360;
    const toFigma = (hex: string) => ({ ...hexToRgb(hex), a: 1 });
    const solid = (hex: string) => [{ type: "SOLID", color: toFigma(hex) }];
    const doc: FigmaNode = {
      id: "0:0",
      name: "Document",
      type: "DOCUMENT",
      children: [
        {
          id: "1:1",
          name: "Styles",
          type: "CANVAS",
          children: [
            { id: "2:1", name: "primary swatch", type: "RECTANGLE", fills: solid(oklchToHex({ l: 0.6, c: 0.18, h })), styles: { fill: "S:1" } },
            { id: "2:2", name: "secondary swatch", type: "RECTANGLE", fills: solid(oklchToHex({ l: 0.7, c: 0.12, h: (h + 150) % 360 })), styles: { fill: "S:2" } },
            { id: "2:3", name: "background swatch", type: "RECTANGLE", fills: solid(oklchToHex({ l: 0.97, c: 0.01, h })), styles: { fill: "S:3" } },
            { id: "2:4", name: "Heading sample", type: "TEXT", style: { fontFamily: "Space Grotesk", fontWeight: 700, fontSize: 64 }, styles: { text: "S:4" } },
            { id: "2:5", name: "Body sample", type: "TEXT", style: { fontFamily: "Inter", fontWeight: 400, fontSize: 16 }, styles: { text: "S:5" } },
          ],
        },
      ],
    };
    return FigmaFileSchema.parse({
      name: `Mock Figma file ${fileKey}`,
      document: doc,
      styles: {
        "S:1": { name: "Brand/Primary", styleType: "FILL" },
        "S:2": { name: "Brand/Secondary", styleType: "FILL" },
        "S:3": { name: "Surface/Background", styleType: "FILL" },
        "S:4": { name: "Heading/Display", styleType: "TEXT" },
        "S:5": { name: "Body/Regular", styleType: "TEXT" },
      },
    });
  }
}

/** FIGMA_PROVIDER=figma|mock (default mock). */
export function createFigmaClient(): FigmaClient {
  return selectAdapter<FigmaClient>("FIGMA_PROVIDER", { figma: () => new FigmaRestClient(), mock: () => new MockFigmaClient() }, "mock").instance;
}
