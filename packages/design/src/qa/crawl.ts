import { chromium, type Browser } from "playwright";

export interface CrawledPage {
  url: string;
  ok: boolean;
  /** Why the page counts as broken (empty when ok). */
  problems: string[];
}

const NOT_FOUND = /\b(404|page not found|not found|cannot get|sidan (kunde inte hittas|hittades inte|finns inte))\b/i;

/**
 * Visit the site like a user: start page, then every same-origin link (up to `max`), plus in-page
 * anchors. A page is broken when it returns HTTP >= 400, shows a not-found page, renders almost no
 * content, or throws an uncaught JavaScript error. Anchors must point at an element that exists.
 */
export async function crawlSite(start: string, opts: { max?: number; browser?: Browser; timeoutMs?: number } = {}): Promise<CrawledPage[]> {
  const browser = opts.browser ?? (await chromium.launch());
  const origin = new URL(start).origin;
  const queue = [new URL(start).href];
  const seen = new Set<string>(queue);
  const out: CrawledPage[] = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    while (queue.length && out.length < (opts.max ?? 25)) {
      const url = queue.shift()!;
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message.slice(0, 160)));
      const problems: string[] = [];
      try {
        const res = await page.goto(url, { waitUntil: "load", timeout: opts.timeoutMs ?? 30_000 });
        await page.waitForTimeout(800);
        if (res && res.status() >= 400) problems.push(`HTTP ${res.status()}`);
        const info = await page.evaluate(() => {
          const text = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim();
          const links = Array.from(document.querySelectorAll("a[href]")).map((a) => (a as HTMLAnchorElement).href);
          const anchors = Array.from(document.querySelectorAll('a[href^="#"]')).map((a) => a.getAttribute("href")!).filter((h) => h.length > 1);
          const missing = anchors.filter((h) => !document.getElementById(decodeURIComponent(h.slice(1))));
          return { text: text.slice(0, 400), length: text.length, links, missing: [...new Set(missing)] };
        });
        if (info.length < 40) problems.push("page is (almost) empty");
        if (NOT_FOUND.test(info.text) && info.length < 400) problems.push("shows a not-found page");
        for (const m of info.missing) problems.push(`link ${m} points to a section that does not exist`);
        for (const e of errors.slice(0, 2)) problems.push(`JavaScript error: ${e}`);
        for (const l of info.links) {
          const u = new URL(l);
          u.hash = "";
          if (u.origin === origin && !seen.has(u.href) && !/\.(png|jpe?g|webp|svg|pdf|zip|mp4)$/i.test(u.pathname)) {
            seen.add(u.href);
            queue.push(u.href);
          }
        }
      } catch (e) {
        problems.push(`did not load: ${(e as Error).message.split("\n")[0]!.slice(0, 160)}`);
      } finally {
        await page.close();
      }
      out.push({ url, ok: problems.length === 0, problems });
    }
    await ctx.close();
  } finally {
    if (!opts.browser) await browser.close();
  }
  return out;
}
