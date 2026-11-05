import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { MemoryUsageSink } from "@forge/shared";
import { MockLLMProvider } from "@forge/llm";
import {
  DEFAULT_THEME,
  DeckSchema,
  DocSchema,
  PlaceholderImageResolver,
  applyDeckEdit,
  applyDeckEdits,
  analyzeBrief,
  chartToPng,
  detectDeckType,
  estimateDeck,
  exportDeckPdf,
  exportDocPdf,
  exportDocx,
  exportPptx,
  generateDeck,
  generateDocument,
  renderChartSvg,
  renderDeckHtml,
  renderDocHtml,
  resolveDeckImages,
  themeFromTokens,
  type Deck,
  type Doc,
} from "../src/index.js";

const BRIEF = 'Pitch deck for "Brightly", an AI tutoring app for high-school students that adapts lessons to each learner';
const DATA = {
  charts: [{ type: "line" as const, title: "Monthly active learners", labels: ["Jan", "Feb", "Mar", "Apr"], series: [{ name: "MAL", values: [120, 340, 610, 980] }] }],
  team: [{ name: "Ada Lind", role: "CEO" }, { name: "Omar Berg", role: "CTO" }],
};

let deck: Deck;
let sink: MemoryUsageSink;

beforeAll(async () => {
  sink = new MemoryUsageSink();
  const r = await generateDeck(new MockLLMProvider(), { brief: BRIEF, slideCount: 10, data: DATA, sink, meter: { projectId: "prj_s" } });
  deck = await resolveDeckImages(r.value, new PlaceholderImageResolver());
});

describe("schemas", () => {
  it("validates decks and reports errors", () => {
    const ok = DeckSchema.safeParse({ title: "T", theme: DEFAULT_THEME, slides: [{ id: "a", layout: "title", title: "Hi" }] });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.slides[0]!.notes).toBe("");
    expect(DeckSchema.safeParse({ title: "T", theme: DEFAULT_THEME, slides: [{ id: "a", layout: "nope", title: "x" }] }).success).toBe(false);
    expect(DeckSchema.safeParse({ title: "T", theme: DEFAULT_THEME, slides: [{ id: "a", layout: "bullets", title: "x" }, { id: "a", layout: "bullets", title: "y" }] }).success).toBe(false);
    const badChart = { id: "c", layout: "chart", title: "c", chart: { type: "bar", labels: ["a", "b"], series: [{ name: "s", values: [1] }] } };
    expect(DeckSchema.safeParse({ title: "T", theme: DEFAULT_THEME, slides: [badChart] }).success).toBe(false);
    const badImage = { id: "i", layout: "image-left", title: "i", image: { alt: "x" } };
    expect(DeckSchema.safeParse({ title: "T", theme: DEFAULT_THEME, slides: [badImage] }).success).toBe(false);
    expect(DeckSchema.safeParse({ title: "T", theme: { ...DEFAULT_THEME, colors: { ...DEFAULT_THEME.colors, bg: "red" } }, slides: [{ id: "a", layout: "title", title: "x" }] }).success).toBe(false);
  });

  it("validates documents (table row widths)", () => {
    const base = { title: "D", sections: [{ id: "s", heading: "S", level: 1, blocks: [{ type: "table", headers: ["a", "b"], rows: [["1", "2"]] }] }] };
    expect(DocSchema.safeParse(base).success).toBe(true);
    const bad = structuredClone(base);
    (bad.sections[0]!.blocks[0] as { rows: string[][] }).rows = [["1"]];
    expect(DocSchema.safeParse(bad).success).toBe(false);
  });

  it("maps loose design tokens onto a theme", () => {
    const t = themeFromTokens({ palette: { background: "#ffffff", primary: "#ff0055", text: "#111111" }, typography: { display: { family: "Fraunces, serif" }, body: "Inter" } });
    expect(t.colors).toMatchObject({ bg: "#ffffff", accent: "#ff0055", text: "#111111" });
    expect(t.fonts).toEqual({ display: "Fraunces", body: "Inter" });
  });
});

describe("generateDeck (mock mode)", () => {
  it("builds a coherent 10-slide pitch deck from the brief", () => {
    expect(deck.slides).toHaveLength(10);
    expect(deck.title).toBe("Brightly");
    expect(deck.slides.map((s) => s.id)).toEqual(["title", "problem", "solution", "market", "product", "business-model", "traction", "competition", "team", "ask"]);
    expect(deck.slides[0]).toMatchObject({ layout: "title", title: "Brightly", subtitle: expect.stringMatching(/AI tutoring app/) });
    expect(deck.slides.find((s) => s.id === "traction")?.chart?.series[0]!.values).toEqual([120, 340, 610, 980]);
    expect(deck.slides.find((s) => s.id === "team")?.bullets).toEqual(["Ada Lind — CEO", "Omar Berg — CTO"]);
    expect(deck.slides.every((s) => s.notes.length > 0)).toBe(true);
    expect(deck.meta?.generator).toMatch(/rule-based mock/);
    // No invented market numbers: placeholders are explicit.
    expect(deck.slides.find((s) => s.id === "market")?.stats?.every((st) => /\[add/.test(st.label))).toBe(true);
    expect(deck.slides.find((s) => s.id === "product")?.image?.url).toMatch(/^data:image\/png;base64,/);
  });

  it("meters usage and estimates cost", () => {
    expect(sink.records.length).toBeGreaterThan(0);
    expect(sink.records[0]).toMatchObject({ provider: "mock", projectId: "prj_s" });
    const e = estimateDeck({ brief: BRIEF, slideCount: 10, model: "claude-sonnet-5-5" });
    expect(e.highUsd).toBeGreaterThan(e.lowUsd);
    expect(e.lowUsd).toBeGreaterThan(0);
  });

  it("detects deck types and Swedish briefs; respects slide counts", async () => {
    expect(detectDeckType("Quarterly report for the board")).toBe("report");
    expect(detectDeckType("Onboarding workshop for new hires")).toBe("training");
    expect(analyzeBrief("Skapa en utbildning för nya medarbetare om säkerhet och rutiner").lang).toBe("sv");
    const sv = await generateDeck(new MockLLMProvider(), { brief: "Skapa en utbildning för nya medarbetare om informationssäkerhet och rutiner", slideCount: 6 });
    expect(sv.value.slides).toHaveLength(6);
    expect(sv.value.slides.map((s) => s.title).join(" ")).toMatch(/Agenda|Lärandemål/);
    const big = await generateDeck(new MockLLMProvider(), { brief: "Annual report on customer support quality and response times", slideCount: 14 });
    expect(big.value.slides).toHaveLength(14);
    expect(new Set(big.value.slides.map((s) => s.id)).size).toBe(14);
  });

  it("uses a real model's structured output when it is valid", async () => {
    const llm = new MockLLMProvider().on("slides.outline", () =>
      JSON.stringify({ title: "Custom", slides: [{ id: "a", layout: "title", title: "Custom", notes: "n" }, { id: "a", layout: "quote", title: "Q", quote: { text: "Hi", author: "Me" }, notes: "" }] }),
    );
    const r = await generateDeck(llm, { brief: "anything at all", slideCount: 2, theme: { colors: { accent: "#00ff00" } } });
    expect(r.value.slides.map((s) => s.id)).toEqual(["a", "a-2"]);
    expect(r.value.theme.colors.accent).toBe("#00ff00");
  });
});

describe("renderers", () => {
  it("renders standalone, accessible, navigable HTML", () => {
    const html = renderDeckHtml(deck);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect((html.match(/<section class="slide/g) ?? []).length).toBe(10);
    expect(html).toContain('aria-roledescription="slide"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("ArrowRight");
    expect(html).toContain("presenter");
    expect(html).toContain("aspect-ratio:16/9");
    expect(html).toContain("<svg"); // chart rendered inline
    expect(html).not.toMatch(/<script[^>]+src=/); // no external scripts
    expect(renderDeckHtml({ ...deck, title: "<script>alert(1)</script>" })).not.toContain("<script>alert(1)</script>");
  });

  it("navigates with the keyboard and shows presenter notes (real browser)", async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await page.setContent(renderDeckHtml(deck));
      const visible = () => page.$$eval("section.slide", (els) => els.filter((e) => !(e as HTMLElement).hidden).map((e) => e.id));
      expect(await visible()).toEqual(["slide-1"]);
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      expect(await visible()).toEqual(["slide-3"]);
      expect(await page.textContent("#live")).toContain("Slide 3 of 10");
      await page.keyboard.press("End");
      expect(await visible()).toEqual(["slide-10"]);
      await page.keyboard.press("Home");
      await page.keyboard.press("n");
      expect(await page.evaluate(() => document.body.classList.contains("show-notes"))).toBe(true);
      expect(await page.textContent("#notes-text")).toBe(deck.slides[0]!.notes);
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("renders charts to SVG and PNG", async () => {
    for (const type of ["bar", "line", "pie", "doughnut"] as const) {
      const chart = { type, labels: ["A", "B", "C"], series: [{ name: "S", values: [3, 5, 2] }] };
      const svg = renderChartSvg(chart);
      expect(svg).toContain("<title");
      const png = await chartToPng(chart, { width: 400, height: 225 });
      const m = await sharp(png).metadata();
      expect(m.format).toBe("png");
      expect(m.width).toBe(400);
    }
  });
});

describe("exports", () => {
  it("PPTX is a valid zip with 10 slides and notes", async () => {
    const bytes = await exportPptx(deck);
    const zip = await JSZip.loadAsync(bytes);
    const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
    const notes = Object.keys(zip.files).filter((f) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(f));
    expect(slides).toHaveLength(10);
    expect(notes).toHaveLength(10);
    const notes1 = await zip.file("ppt/notesSlides/notesSlide1.xml")!.async("string");
    expect(notes1).toContain("Brightly");
    expect(Object.keys(zip.files).some((f) => /^ppt\/charts\/chart\d+\.xml$/.test(f))).toBe(true); // native chart
    expect(Object.keys(zip.files).some((f) => /^ppt\/media\/image/.test(f))).toBe(true);
    const s1 = await zip.file("ppt/slides/slide1.xml")!.async("string");
    expect(s1).toContain('typeface="Inter"');
  });

  it("PDF has one page per slide", async () => {
    const pdf = await PDFDocument.load(await exportDeckPdf(deck));
    expect(pdf.getPageCount()).toBe(10);
    const { width, height } = pdf.getPage(0).getSize();
    expect(Math.round((width / height) * 100) / 100).toBeCloseTo(16 / 9, 1);
  }, 60_000);
});

describe("editor operations", () => {
  const base = (): Deck => structuredClone(deck);

  it("updates fields without mutating the input", () => {
    const d = base();
    const next = applyDeckEdit(d, { op: "updateSlide", slideId: "problem", patch: { title: "The real problem", bullets: ["One"] } });
    expect(next.slides[1]).toMatchObject({ title: "The real problem", bullets: ["One"] });
    expect(d.slides[1]!.title).toBe("The problem");
    expect(applyDeckEdit(d, { op: "setTitle", title: "New" }).title).toBe("New");
  });

  it("adds, removes, reorders and duplicates slides", () => {
    let d = applyDeckEdit(base(), { op: "addSlide", slide: { layout: "quote", title: "Q", quote: { text: "Great", author: "A" } }, index: 1 });
    expect(d.slides).toHaveLength(11);
    expect(d.slides[1]!.layout).toBe("quote");
    expect(d.slides[1]!.id).toMatch(/^slide-\d+$/);
    d = applyDeckEdit(d, { op: "removeSlide", slideId: d.slides[1]!.id });
    expect(d.slides.map((s) => s.id)).toEqual(deck.slides.map((s) => s.id));
    d = applyDeckEdit(d, { op: "moveSlide", slideId: "team", toIndex: 1 });
    expect(d.slides[1]!.id).toBe("team");
    d = applyDeckEdit(d, { op: "duplicateSlide", slideId: "team" });
    expect(d.slides[2]!.title).toBe("Team");
    expect(new Set(d.slides.map((s) => s.id)).size).toBe(d.slides.length);
  });

  it("changes layout with content migration and changes theme", () => {
    const d = applyDeckEdits(base(), [
      { op: "changeLayout", slideId: "problem", layout: "two-column" },
      { op: "changeLayout", slideId: "solution", layout: "timeline" },
      { op: "changeTheme", theme: { colors: { accent: "#ff0066" }, fonts: { display: "Fraunces" } } },
    ]);
    const problem = d.slides.find((s) => s.id === "problem")!;
    expect(problem.layout).toBe("two-column");
    expect(problem.columns?.flatMap((c) => c.bullets ?? [])).toHaveLength(3);
    expect(d.slides.find((s) => s.id === "solution")!.timeline).toHaveLength(3);
    expect(d.theme.colors.accent).toBe("#ff0066");
    expect(d.theme.fonts).toEqual({ display: "Fraunces", body: "Inter" });
  });

  it("rejects invalid edits", () => {
    expect(() => applyDeckEdit(base(), { op: "removeSlide", slideId: "nope" })).toThrow(/No slide/);
    expect(() => applyDeckEdit(base(), { op: "changeTheme", theme: { colors: { accent: "pink" } } })).toThrow(/Invalid deck edit/);
    const one: Deck = { ...base(), slides: [deck.slides[0]!] };
    expect(() => applyDeckEdit(one, { op: "removeSlide", slideId: "title" })).toThrow(/at least one/);
    expect(() => applyDeckEdit(base(), { op: "addSlide", slide: { id: "title", layout: "title", title: "dup" } })).toThrow(/already exists/);
  });
});

describe("documents", () => {
  let doc: Doc;
  beforeAll(async () => {
    const r = await generateDocument(new MockLLMProvider(), {
      brief: "Market analysis for Nordic e-bike subscriptions targeting urban commuters",
      data: { charts: [{ type: "bar", title: "Subscribers by country", labels: ["SE", "NO", "DK"], series: [{ name: "2026", values: [12, 8, 5] }] }], competitors: ["Swapfiets", "Dance"] },
      images: new PlaceholderImageResolver(),
    });
    doc = r.value;
  });

  it("generates a market analysis structure (mock)", () => {
    const ids = doc.sections.map((s) => s.id);
    for (const id of ["executive-summary", "market-size", "segments", "competitors", "trends", "risks", "recommendations"]) expect(ids).toContain(id);
    expect(new Set(doc.sections.map((s) => s.level))).toEqual(new Set([1, 2, 3]));
    const comp = doc.sections.find((s) => s.id === "competitors")!.blocks.find((b) => b.type === "table");
    expect(comp && comp.type === "table" ? comp.rows.map((r) => r[0]) : []).toEqual(["Swapfiets", "Dance"]);
    expect(doc.meta?.generator).toMatch(/rule-based mock/);
  });

  it("DOCX contains headings, a table and an image", async () => {
    const zip = await JSZip.loadAsync(await exportDocx(doc));
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain('w:val="Heading1"');
    expect(xml).toContain('w:val="Heading2"');
    expect(xml).toContain('w:val="Heading3"');
    expect(xml).toContain("<w:tbl>");
    expect(xml).toContain("<w:drawing>");
    expect(xml).toContain("Executive summary");
    const media = Object.keys(zip.files).filter((f) => f.startsWith("word/media/"));
    expect(media.length).toBeGreaterThanOrEqual(2); // cover image + chart PNG
  });

  it("renders HTML and an A4 PDF", async () => {
    const html = renderDocHtml(doc);
    expect(html).toContain("<h1 id=\"executive-summary\">");
    expect(html).toContain("<table>");
    expect(html).toContain("<svg");
    const pdf = await PDFDocument.load(await exportDocPdf(doc));
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);
    const { width, height } = pdf.getPage(0).getSize();
    expect(Math.round(width)).toBe(595); // A4 portrait in points
    expect(Math.round(height)).toBe(842);
  }, 60_000);
});
