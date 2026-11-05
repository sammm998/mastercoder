import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ParagraphChild,
} from "docx";
import sharp from "sharp";
import type { Doc, DocBlock, DeckTheme } from "./schema.js";
import { chartToPng } from "./chart-svg.js";
import { loadImageBytes } from "./images.js";
import { LIGHT_THEME } from "./theme.js";

const hex = (c: string) => c.replace("#", "").toUpperCase();
const HEADINGS = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 } as const;
const TONE_FILL: Record<string, [string, string]> = { info: ["EEF4FF", "3B82F6"], warning: ["FFF6E6", "F59E0B"], success: ["ECFDF3", "10B981"], note: ["F4F4F6", "6B7280"] };
/** Max image width in the document body (px at 96 dpi ≈ 6.25 in). */
const MAX_W = 600;

async function imageRun(bytes: Uint8Array, alt: string): Promise<ImageRun> {
  const png = await sharp(bytes).png().toBuffer();
  const m = await sharp(png).metadata();
  const w = m.width ?? MAX_W;
  const h = m.height ?? Math.round(MAX_W * 0.56);
  const scale = Math.min(1, MAX_W / w);
  return new ImageRun({ type: "png", data: png, transformation: { width: Math.round(w * scale), height: Math.round(h * scale) }, altText: { title: alt, description: alt, name: alt.slice(0, 40) } });
}

function caption(text: string | undefined): Paragraph[] {
  return text ? [new Paragraph({ children: [new TextRun({ text, italics: true, size: 18, color: "6B7280" })], spacing: { after: 200 } })] : [];
}

async function blockToDocx(b: DocBlock, theme: DeckTheme, listCounter: { n: number }): Promise<Array<Paragraph | Table>> {
  switch (b.type) {
    case "paragraph":
      return [new Paragraph({ children: [new TextRun(b.text)], spacing: { before: 120, after: 160 } })];
    case "bullets":
      return b.items.map((t) => new Paragraph({ text: t, bullet: { level: 0 }, spacing: { after: 60 } }));
    case "numbered": {
      const instance = ++listCounter.n;
      return b.items.map((t) => new Paragraph({ text: t, numbering: { reference: "forge-numbered", level: 0, instance }, spacing: { after: 60 } }));
    }
    case "table": {
      const border = { style: BorderStyle.SINGLE, size: 4, color: "D1D5DB" };
      const borders = { top: border, bottom: border, left: border, right: border };
      const header = new TableRow({
        tableHeader: true,
        children: b.headers.map(
          (h) => new TableCell({ borders, shading: { type: ShadingType.CLEAR, fill: hex(theme.colors.surface), color: "auto" }, children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })] }),
        ),
      });
      const rows = b.rows.map((r) => new TableRow({ children: r.map((cell, i) => new TableCell({ borders, children: [new Paragraph({ children: [new TextRun({ text: cell, bold: i === 0 })] })] })) }));
      return [new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [header, ...rows] }), ...caption(b.caption)];
    }
    case "image": {
      const img = await loadImageBytes(b.image).catch(() => undefined);
      if (!img) return [new Paragraph({ children: [new TextRun({ text: `[Image not generated yet: ${b.image.alt}]`, italics: true, color: "6B7280" })] }), ...caption(b.caption)];
      return [new Paragraph({ children: [await imageRun(img.bytes, b.image.alt)], spacing: { before: 120, after: 80 } }), ...caption(b.caption)];
    }
    case "chart": {
      const png = await chartToPng(b.chart, { theme, width: 1200, height: 640 });
      return [new Paragraph({ children: [await imageRun(png, b.chart.title ?? b.caption ?? `${b.chart.type} chart`)], spacing: { before: 120, after: 80 } }), ...caption(b.caption)];
    }
    case "callout": {
      const [fill, line] = TONE_FILL[b.tone] ?? (TONE_FILL.note as [string, string]);
      const children: ParagraphChild[] = [];
      if (b.title) children.push(new TextRun({ text: `${b.title}  `, bold: true }));
      children.push(new TextRun(b.text));
      return [
        new Paragraph({
          children,
          shading: { type: ShadingType.CLEAR, fill, color: "auto" },
          border: { left: { style: BorderStyle.SINGLE, size: 24, color: line, space: 8 } },
          spacing: { before: 160, after: 160 },
          indent: { left: 120, right: 120 },
        }),
      ];
    }
  }
}

/** Export a document to DOCX (headings h1–h3, lists, tables, images, charts as PNG, callouts, page numbers). */
export async function exportDocx(doc: Doc): Promise<Uint8Array> {
  const theme = doc.theme ?? LIGHT_THEME;
  const display = theme.fonts.display;
  const bodyFont = theme.fonts.body;
  const listCounter = { n: 0 };
  const children: Array<Paragraph | Table> = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: doc.title })] }),
  ];
  if (doc.subtitle) children.push(new Paragraph({ children: [new TextRun({ text: doc.subtitle, size: 28, color: hex(theme.colors.muted) })], spacing: { after: 120 } }));
  const byline = [doc.author, doc.date].filter(Boolean).join(" · ");
  if (byline) children.push(new Paragraph({ children: [new TextRun({ text: byline, size: 20, color: hex(theme.colors.muted) })], spacing: { after: 360 } }));
  for (const s of doc.sections) {
    children.push(new Paragraph({ heading: HEADINGS[s.level], children: [new TextRun(s.heading)] }));
    for (const b of s.blocks) children.push(...(await blockToDocx(b, theme, listCounter)));
  }
  const accent = hex(theme.colors.accent);
  const document = new Document({
    title: doc.title,
    creator: doc.author ?? "Forge",
    description: typeof doc.meta?.generator === "string" ? `Generated by Forge (${doc.meta.generator})` : "Generated by Forge",
    styles: {
      default: { document: { run: { font: bodyFont, size: 22 } }, heading1: { run: { font: display, size: 36, bold: true, color: "111318" }, paragraph: { spacing: { before: 360, after: 140 } } },
        heading2: { run: { font: display, size: 28, bold: true, color: "111318" }, paragraph: { spacing: { before: 280, after: 120 } } },
        heading3: { run: { font: display, size: 24, bold: true, color: accent }, paragraph: { spacing: { before: 220, after: 100 } } },
        title: { run: { font: display, size: 56, bold: true, color: "111318" }, paragraph: { spacing: { after: 120 } } } },
    },
    numbering: {
      config: [{ reference: "forge-numbered", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] }],
    },
    sections: [
      {
        footers: {
          default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, color: "6B7280" })] })] }),
        },
        children,
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(document));
}
