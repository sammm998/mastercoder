import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { crawlSite } from "../src/qa/crawl.js";

const pages: Record<string, string> = {
  "/": `<h1>Remanis</h1><p>Industrial automation for Nordic manufacturers, built to last.</p><a href="/services">Services</a> <a href="/about">About</a> <a href="#contact">Contact</a>`,
  "/services": `<h1>Services</h1><p>Robot cells, PLC programming, service agreements and training.</p><a href="/">Home</a>`,
};

describe("crawlSite", () => {
  it("follows internal links and reports 404s and dead anchors", async () => {
    const server = createServer((req, res) => {
      const body = pages[req.url ?? "/"];
      res.writeHead(body ? 200 : 404, { "content-type": "text/html" });
      res.end(`<!doctype html><html><body>${body ?? "<h1>404</h1><p>Not found</p>"}</body></html>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const out = await crawlSite(`${base}/`);
      const by = Object.fromEntries(out.map((p) => [new URL(p.url).pathname, p]));
      expect(by["/"]?.problems).toEqual(["link #contact points to a section that does not exist"]);
      expect(by["/services"]?.ok).toBe(true);
      expect(by["/about"]?.problems.join(" ")).toMatch(/HTTP 404/);
    } finally {
      server.close();
    }
  }, 60_000);
});
