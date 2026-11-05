import { chromium, type Browser } from "playwright";
import type { Deck, Doc } from "./schema.js";
import { renderDeckHtml } from "./html.js";
import { renderDocHtml } from "./doc-html.js";

export interface PdfOptions {
  /** Reuse an already launched Playwright browser. */
  browser?: Browser;
}

/** Print HTML to PDF with Playwright Chromium (`page.pdf`). */
export async function htmlToPdf(
  html: string,
  pdf: { width?: string; height?: string; format?: "A4" | "Letter"; preferCSSPageSize?: boolean },
  opts: PdfOptions = {},
): Promise<Uint8Array> {
  const browser = opts.browser ?? (await chromium.launch());
  try {
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: "load" });
      await page.emulateMedia({ media: "print" });
      await page.evaluate(() => document.fonts.ready);
      const bytes = await page.pdf({ ...pdf, printBackground: true });
      return new Uint8Array(bytes);
    } finally {
      await page.close();
    }
  } finally {
    if (!opts.browser) await browser.close();
  }
}

/** Deck → PDF, one 1280×720 page per slide. Resolve images first (resolveDeckImages) to embed them. */
export function exportDeckPdf(deck: Deck, opts: PdfOptions = {}): Promise<Uint8Array> {
  return htmlToPdf(renderDeckHtml(deck, { mode: "print" }), { width: "1280px", height: "720px", preferCSSPageSize: true }, opts);
}

/** Document → A4 PDF via HTML print. */
export function exportDocPdf(doc: Doc, opts: PdfOptions = {}): Promise<Uint8Array> {
  return htmlToPdf(renderDocHtml(doc), { format: "A4", preferCSSPageSize: true }, opts);
}
