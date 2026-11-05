import { describe, it, expect } from "vitest";
import { RepoMap, extractSymbols, fileRoute, HashingEmbedder, MemoryVectorIndex, chunkFile, cosine } from "../src/index.js";

describe("repo map (tree-sitter)", () => {
  it("extracts exports, components and routes from TSX", async () => {
    const s = await extractSymbols(
      "src/app/bookings/page.tsx",
      `import { db } from "@/db";\nexport default function BookingsPage() { return <main>hi</main>; }\nexport const revalidate = 60;\nexport function useThing() { return 1 }`,
    );
    expect(s.routes).toContain("/bookings");
    expect(s.exports).toEqual(expect.arrayContaining(["default BookingsPage", "revalidate", "useThing"]));
    expect(s.components).toContain("BookingsPage");
    expect(s.imports).toContain("@/db");
  });
  it("finds Next route handlers, Hono routes and FastAPI routes", async () => {
    const next = await extractSymbols("app/api/items/route.ts", "export async function GET() {}\nexport async function POST() {}");
    expect(next.routes).toEqual(expect.arrayContaining(["API /api/items", "GET /api/items", "POST /api/items"]));
    const hono = await extractSymbols("src/index.ts", `const app = new Hono();\napp.get("/health", (c) => c.json({}));\napp.post('/items', h);\nexport default app;`);
    expect(hono.routes).toEqual(expect.arrayContaining(["GET /health", "POST /items"]));
    const py = await extractSymbols("app/main.py", `@app.get("/items")\ndef list_items():\n  pass\n\nclass Item(BaseModel):\n  name: str\n`);
    expect(py.routes).toContain("GET /items");
    expect(py.exports).toEqual(expect.arrayContaining(["list_items", "Item"]));
  });
  it("maps route conventions and renders incrementally", async () => {
    expect(fileRoute("app/(marketing)/about/page.tsx")).toBe("/about");
    expect(fileRoute("src/pages/blog/index.astro")).toBe("/blog");
    const m = new RepoMap();
    expect(await m.update("a.ts", "export const a = 1")).toBe(true);
    expect(await m.update("a.ts", "export const a = 1")).toBe(false);
    expect(await m.update("node_modules/x/index.js", "export const x = 1")).toBe(false);
    expect(m.render()).toContain("a.ts (1L) | exports: a");
  });
});

describe("semantic file search", () => {
  it("ranks relevant files first", async () => {
    const idx = new MemoryVectorIndex(new HashingEmbedder());
    await idx.upsertFile("p", "src/booking/createBooking.ts", "export async function createBooking(stylistId, startsAt) { /* prevent double booking */ }");
    await idx.upsertFile("p", "src/ui/Button.tsx", "export function Button({ children }) { return <button>{children}</button> }");
    await idx.upsertFile("other", "src/booking/x.ts", "booking booking booking");
    const hits = await idx.search("p", "where do we prevent double booking for a stylist?", 2);
    expect(hits[0]?.path).toBe("src/booking/createBooking.ts");
    expect(hits.every((h) => !h.path.startsWith("other"))).toBe(true);
  });
  it("chunks and normalises", async () => {
    expect(chunkFile("a.ts", Array.from({ length: 130 }, (_, i) => `l${i}`).join("\n")).length).toBe(3);
    const [v] = await new HashingEmbedder().embed(["hello world"]);
    expect(cosine(v!, v!)).toBeCloseTo(1);
  });
});
