import PptxGenJS from "pptxgenjs";
import sharp from "sharp";
import type { Chart, Deck, ImageRef, Slide } from "./schema.js";
import { loadImageBytes } from "./images.js";
import { seriesColors } from "./theme.js";

type PSlide = ReturnType<PptxGenJS["addSlide"]>;

const W = 13.333;
const H = 7.5;
const M = 0.8;

const hex = (c: string) => c.replace("#", "").toUpperCase();

interface Ctx {
  pptx: PptxGenJS;
  deck: Deck;
  c: Deck["theme"]["colors"];
  display: string;
  body: string;
}

async function coverImage(ref: ImageRef | undefined, wIn: number, hIn: number): Promise<string | undefined> {
  const img = await loadImageBytes(ref).catch(() => undefined);
  if (!img) return undefined;
  const png = await sharp(img.bytes).resize(Math.round(wIn * 150), Math.round(hIn * 150), { fit: "cover" }).png().toBuffer();
  return `image/png;base64,${png.toString("base64")}`;
}

async function addImageOrPlaceholder(ctx: Ctx, s: PSlide, ref: ImageRef | undefined, x: number, y: number, w: number, h: number): Promise<void> {
  const data = await coverImage(ref, w, h);
  if (data) {
    s.addImage({ data, x, y, w, h, altText: ref?.alt });
    return;
  }
  s.addShape(ctx.pptx.ShapeType.rect, { x, y, w, h, fill: { color: hex(ctx.c.surface) }, line: { color: hex(ctx.c.muted), dashType: "dash", width: 1 } });
  s.addText([{ text: ref?.alt ?? "Image", options: { breakLine: true } }, { text: "image not generated yet", options: { fontSize: 11 } }], {
    x, y, w, h, align: "center", valign: "middle", fontFace: ctx.body, fontSize: 16, color: hex(ctx.c.muted),
  });
}

function title(ctx: Ctx, s: PSlide, text: string, y = 0.55, size = 32): void {
  s.addText(text, { x: M, y, w: W - 2 * M, h: 0.95, fontFace: ctx.display, fontSize: size, bold: true, color: hex(ctx.c.text), valign: "top", fit: "shrink" });
}

function subtitle(ctx: Ctx, s: PSlide, text: string | undefined, y: number, x = M, w = W - 2 * M): void {
  if (text) s.addText(text, { x, y, w, h: 0.6, fontFace: ctx.body, fontSize: 18, color: hex(ctx.c.muted), valign: "top" });
}

function bullets(ctx: Ctx, s: PSlide, items: string[] | undefined, x: number, y: number, w: number, h: number, size = 20): void {
  if (!items?.length) return;
  s.addText(
    items.map((b) => ({ text: b, options: { bullet: { indent: 18 }, paraSpaceAfter: 10, breakLine: true } })),
    { x, y, w, h, fontFace: ctx.body, fontSize: size, color: hex(ctx.c.text), valign: "top", fit: "shrink" },
  );
}

function body(ctx: Ctx, s: PSlide, text: string | undefined, x: number, y: number, w: number, h: number, size = 16): void {
  if (text) s.addText(text, { x, y, w, h, fontFace: ctx.body, fontSize: size, color: hex(ctx.c.text), valign: "top", fit: "shrink" });
}

function chart(ctx: Ctx, s: PSlide, ch: Chart, x: number, y: number, w: number, h: number): void {
  const T = ctx.pptx.ChartType;
  const type = ch.type === "bar" ? T.bar : ch.type === "line" ? T.line : ch.type === "pie" ? T.pie : T.doughnut;
  const data = ch.series.map((se) => ({ name: se.name, labels: ch.labels, values: se.values }));
  const round = ch.type === "pie" || ch.type === "doughnut";
  s.addChart(type, data, {
    x, y, w, h,
    barDir: "col",
    chartColors: (round ? seriesColors(ctx.deck.theme).concat(seriesColors(ctx.deck.theme)) : seriesColors(ctx.deck.theme)).map(hex).slice(0, round ? ch.labels.length : ch.series.length),
    showLegend: round || ch.series.length > 1,
    legendPos: round ? "r" : "b",
    legendColor: hex(ctx.c.muted),
    legendFontFace: ctx.body,
    catAxisLabelColor: hex(ctx.c.muted),
    valAxisLabelColor: hex(ctx.c.muted),
    catAxisLabelFontFace: ctx.body,
    valAxisLabelFontFace: ctx.body,
    valGridLine: { color: hex(ctx.c.border ?? ctx.c.muted), style: "dash", size: 0.5 },
    catGridLine: { style: "none" },
    showValue: !round && ch.labels.length * ch.series.length <= 16,
    dataLabelColor: hex(ctx.c.text),
    dataLabelFontSize: 11,
    showPercent: round,
    holeSize: ch.type === "doughnut" ? 58 : undefined,
    lineSize: 3,
    lineDataSymbolSize: 8,
    showTitle: Boolean(ch.title),
    title: ch.title,
    titleColor: hex(ctx.c.text),
    titleFontFace: ctx.display,
  });
}

async function renderSlide(ctx: Ctx, s: PSlide, sl: Slide, index: number): Promise<void> {
  const c = ctx.c;
  switch (sl.layout) {
    case "title":
      s.addShape(ctx.pptx.ShapeType.roundRect, { x: M, y: 2.35, w: 1.2, h: 0.09, fill: { color: hex(c.accent) }, rectRadius: 0.04, line: { type: "none" } });
      s.addText(sl.title, { x: M, y: 2.6, w: W - 2 * M - 1, h: 1.7, fontFace: ctx.display, fontSize: 48, bold: true, color: hex(c.text), valign: "top", fit: "shrink" });
      subtitle(ctx, s, sl.subtitle, 4.4, M, W - 2 * M - 2);
      body(ctx, s, sl.body, M, 5.1, W - 2 * M - 2, 1.2);
      break;
    case "section":
      s.background = { color: hex(c.surface) };
      s.addText(String(index + 1).padStart(2, "0"), { x: M, y: 1.6, w: 4, h: 1.8, fontFace: ctx.display, fontSize: 96, bold: true, color: hex(c.accent) });
      s.addText(sl.title, { x: M, y: 3.5, w: W - 2 * M, h: 1.2, fontFace: ctx.display, fontSize: 40, bold: true, color: hex(c.text), fit: "shrink" });
      subtitle(ctx, s, sl.subtitle, 4.8);
      break;
    case "bullets":
      title(ctx, s, sl.title);
      subtitle(ctx, s, sl.subtitle, 1.45);
      bullets(ctx, s, sl.bullets, M, sl.subtitle ? 2.1 : 1.75, W - 2 * M, 4.2);
      body(ctx, s, sl.body, M, 6.0, W - 2 * M, 0.8, 14);
      break;
    case "two-column": {
      title(ctx, s, sl.title);
      const cols = sl.columns?.length ? sl.columns : [{ bullets: sl.bullets?.slice(0, Math.ceil((sl.bullets?.length ?? 0) / 2)) }, { bullets: sl.bullets?.slice(Math.ceil((sl.bullets?.length ?? 0) / 2)) }];
      const gap = 0.4;
      const cw = (W - 2 * M - gap * (cols.length - 1)) / cols.length;
      cols.forEach((col, i) => {
        const x = M + i * (cw + gap);
        s.addShape(ctx.pptx.ShapeType.roundRect, { x, y: 1.75, w: cw, h: 4.9, fill: { color: hex(c.surface) }, line: { color: hex(c.border ?? c.muted), width: 0.75 }, rectRadius: 0.12 });
        if (col.heading) s.addText(col.heading, { x: x + 0.3, y: 1.95, w: cw - 0.6, h: 0.6, fontFace: ctx.display, fontSize: 20, bold: true, color: hex(c.accent2) });
        bullets(ctx, s, col.bullets, x + 0.3, col.heading ? 2.6 : 2.0, cw - 0.6, 3.2, 16);
        body(ctx, s, col.body, x + 0.3, 5.6, cw - 0.6, 0.9, 13);
      });
      break;
    }
    case "image-left":
      await addImageOrPlaceholder(ctx, s, sl.image, 0, 0, W * 0.46, H);
      s.addText(sl.title, { x: W * 0.46 + 0.6, y: 0.9, w: W * 0.54 - 1.2, h: 1.2, fontFace: ctx.display, fontSize: 30, bold: true, color: hex(c.text), valign: "top", fit: "shrink" });
      subtitle(ctx, s, sl.subtitle, 2.1, W * 0.46 + 0.6, W * 0.54 - 1.2);
      bullets(ctx, s, sl.bullets, W * 0.46 + 0.6, 2.7, W * 0.54 - 1.2, 3.6, 18);
      body(ctx, s, sl.body, W * 0.46 + 0.6, sl.bullets?.length ? 6.3 : 2.8, W * 0.54 - 1.2, 1.0, 15);
      break;
    case "image-full":
      await addImageOrPlaceholder(ctx, s, sl.image, 0, 0, W, H);
      s.addShape(ctx.pptx.ShapeType.rect, { x: 0, y: H - 2.4, w: W, h: 2.4, fill: { color: hex(c.bg), transparency: 25 }, line: { type: "none" } });
      s.addText(sl.title, { x: M, y: H - 2.2, w: W - 2 * M, h: 1.1, fontFace: ctx.display, fontSize: 36, bold: true, color: hex(c.text), fit: "shrink" });
      subtitle(ctx, s, sl.subtitle ?? sl.body, H - 1.1);
      break;
    case "chart":
      title(ctx, s, sl.title);
      subtitle(ctx, s, sl.subtitle, 1.45);
      if (sl.chart) chart(ctx, s, sl.chart.title === sl.title ? { ...sl.chart, title: undefined } : sl.chart, M, sl.subtitle ? 2.0 : 1.7, W - 2 * M, sl.body ? 4.4 : 5.0);
      else body(ctx, s, "No chart data provided.", M, 2, W - 2 * M, 1);
      body(ctx, s, sl.body, M, 6.5, W - 2 * M, 0.6, 12);
      break;
    case "quote":
      s.addShape(ctx.pptx.ShapeType.rect, { x: M, y: 1.8, w: 0.1, h: 3.6, fill: { color: hex(c.accent) }, line: { type: "none" } });
      s.addText(`“${sl.quote?.text ?? sl.body ?? sl.title}”`, { x: M + 0.5, y: 1.7, w: W - 2 * M - 1, h: 3.0, fontFace: ctx.display, fontSize: 30, bold: true, color: hex(c.text), valign: "middle", fit: "shrink" });
      if (sl.quote?.author) s.addText(`— ${sl.quote.author}`, { x: M + 0.5, y: 4.8, w: W - 2 * M - 1, h: 0.6, fontFace: ctx.body, fontSize: 18, color: hex(c.muted) });
      break;
    case "stats": {
      title(ctx, s, sl.title);
      subtitle(ctx, s, sl.subtitle, 1.45);
      const stats = sl.stats ?? [];
      const gap = 0.35;
      const n = Math.max(1, stats.length);
      const cw = (W - 2 * M - gap * (n - 1)) / n;
      stats.forEach((st, i) => {
        const x = M + i * (cw + gap);
        s.addShape(ctx.pptx.ShapeType.roundRect, { x, y: 2.4, w: cw, h: 2.9, fill: { color: hex(c.surface) }, line: { color: hex(c.border ?? c.muted), width: 0.75 }, rectRadius: 0.12 });
        s.addText(st.value, { x: x + 0.25, y: 2.6, w: cw - 0.5, h: 1.3, fontFace: ctx.display, fontSize: st.value.length > 7 ? 28 : 44, bold: true, color: hex(c.accent), fit: "shrink" });
        s.addText(st.label, { x: x + 0.25, y: 3.9, w: cw - 0.5, h: 1.2, fontFace: ctx.body, fontSize: 14, color: hex(c.muted), valign: "top" });
      });
      body(ctx, s, sl.body, M, 5.8, W - 2 * M, 0.9, 13);
      break;
    }
    case "timeline": {
      title(ctx, s, sl.title);
      const items = sl.timeline?.length ? sl.timeline : (sl.bullets ?? []).map((b, i) => ({ label: String(i + 1), text: b }));
      const n = Math.max(1, items.length);
      const cw = (W - 2 * M) / n;
      s.addShape(ctx.pptx.ShapeType.line, { x: M, y: 3.0, w: W - 2 * M, h: 0, line: { color: hex(c.border ?? c.muted), width: 2 } });
      items.forEach((t, i) => {
        const x = M + i * cw;
        s.addShape(ctx.pptx.ShapeType.ellipse, { x, y: 2.85, w: 0.3, h: 0.3, fill: { color: hex(c.accent) }, line: { color: hex(c.bg), width: 3 } });
        s.addText(t.label, { x, y: 3.3, w: cw - 0.2, h: 0.5, fontFace: ctx.display, fontSize: 18, bold: true, color: hex(c.accent2) });
        s.addText(t.text, { x, y: 3.8, w: cw - 0.2, h: 2.2, fontFace: ctx.body, fontSize: 14, color: hex(c.text), valign: "top", fit: "shrink" });
      });
      break;
    }
    case "closing":
      s.addText(sl.title, { x: M, y: 2.3, w: W - 2 * M, h: 1.4, fontFace: ctx.display, fontSize: 44, bold: true, color: hex(c.text), align: "center", fit: "shrink" });
      if (sl.subtitle) s.addText(sl.subtitle, { x: M, y: 3.7, w: W - 2 * M, h: 0.7, fontFace: ctx.body, fontSize: 20, color: hex(c.muted), align: "center" });
      if (sl.body) s.addText(sl.body, { x: M + 1, y: 4.4, w: W - 2 * M - 2, h: 1, fontFace: ctx.body, fontSize: 16, color: hex(c.text), align: "center" });
      if (sl.bullets?.length) s.addText(sl.bullets.join("   ·   "), { x: M, y: 5.4, w: W - 2 * M, h: 0.6, fontFace: ctx.body, fontSize: 14, color: hex(c.muted), align: "center" });
      break;
  }
  if (sl.layout !== "image-full") {
    s.addText(`${ctx.deck.title}`, { x: sl.layout === "image-left" ? W * 0.46 + 0.6 : M, y: H - 0.5, w: 6, h: 0.3, fontFace: ctx.body, fontSize: 9, color: hex(c.muted) });
    s.addText(`${index + 1} / ${ctx.deck.slides.length}`, { x: W - M - 2, y: H - 0.5, w: 2, h: 0.3, fontFace: ctx.body, fontSize: 9, color: hex(c.muted), align: "right" });
  }
}

/** Export a deck to PPTX (native charts, images, speaker notes, theme fonts/colours). */
export async function exportPptx(deck: Deck): Promise<Uint8Array> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = deck.title;
  pptx.company = "Forge";
  pptx.theme = { headFontFace: deck.theme.fonts.display, bodyFontFace: deck.theme.fonts.body };
  const c = deck.theme.colors;
  pptx.defineSlideMaster({ title: "FORGE", background: { color: hex(c.bg) } });
  const ctx: Ctx = { pptx, deck, c, display: deck.theme.fonts.display, body: deck.theme.fonts.body };
  for (const [i, sl] of deck.slides.entries()) {
    const s = pptx.addSlide({ masterName: "FORGE" });
    if (sl.layout === "title" || sl.layout === "closing") s.background = { color: hex(c.bg) };
    await renderSlide(ctx, s, sl, i);
    s.addNotes(sl.notes?.trim() ? sl.notes : " ");
  }
  const out = await pptx.write({ outputType: "uint8array" });
  return out as Uint8Array;
}
