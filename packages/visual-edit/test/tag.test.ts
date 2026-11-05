import { describe, it, expect } from "vitest";
import { transformSync } from "@babel/core";
import forgeSourceTagsBabel from "../src/babel-plugin.js";
import { forgeSourceTags } from "../src/vite-plugin.js";
import { tagJsxSource, relativePath } from "../src/tag.js";
import { INSPECTOR_SCRIPT } from "../src/inspector-script.js";

const APP = `import { Card } from "./Card";
import * as UI from "./ui";
export function App() {
  return (
    <main className="p-4">
      <h1>Hello</h1>
      <Card title="x"><span>inside</span></Card>
      <UI.Button />
      <svg viewBox="0 0 10 10"><path d="M0 0" /></svg>
      <>
        <p data-forge-src="keep:1:1">kept</p>
      </>
    </main>
  );
}
`;

describe("tagJsxSource (Vite transform core)", () => {
  it("tags host elements only, with 1-based line:col of the opening <", () => {
    const r = tagJsxSource(APP, "src/App.tsx")!;
    expect(r.count).toBe(5);
    expect(r.code).toContain(`<main data-forge-src="src/App.tsx:5:5" className="p-4">`);
    expect(r.code).toContain(`<h1 data-forge-src="src/App.tsx:6:7">Hello</h1>`);
    expect(r.code).toContain(`<span data-forge-src="src/App.tsx:7:23">inside</span>`);
    expect(r.code).toContain(`<svg data-forge-src="src/App.tsx:9:7" viewBox`);
    expect(r.code).toContain(`<path data-forge-src="src/App.tsx:9:32" d=`);
    expect(r.code).toContain(`<Card title="x">`);
    expect(r.code).toContain(`<UI.Button />`);
    expect(r.code).toContain(`<p data-forge-src="keep:1:1">kept</p>`);
    expect(r.map.mappings.length).toBeGreaterThan(0);
  });

  it("returns null when there is nothing to tag", () => {
    expect(tagJsxSource("export const x = 1 < 2;", "a.ts")).toBeNull();
    expect(tagJsxSource("export const n = 1;", "a.ts")).toBeNull();
  });

  it("makes ids relative to the root", () => {
    expect(relativePath("/home/u/app/src/App.tsx", "/home/u/app")).toBe("src/App.tsx");
    expect(relativePath("C:\\app\\src\\A.tsx", "C:\\app")).toBe("src/A.tsx");
    expect(relativePath("/home/u/app/src/App.tsx?v=1", "/home/u/app/")).toBe("src/App.tsx");
  });
});

describe("forgeSourceTags() Vite plugin", () => {
  const plugin = forgeSourceTags();
  type Hook = (this: unknown, ...args: unknown[]) => unknown;
  const call = (h: unknown, ...args: unknown[]) => (typeof h === "function" ? (h as Hook) : (h as { handler: Hook }).handler).call({}, ...args);

  it("is dev-only and runs before other transforms", () => {
    expect(plugin.apply).toBe("serve");
    expect(plugin.enforce).toBe("pre");
  });

  it("transforms tsx under the root and skips node_modules / other files", () => {
    call(plugin.configResolved, { root: "/proj" });
    const out = call(plugin.transform, APP, "/proj/src/App.tsx") as { code: string } | null;
    expect(out?.code).toContain(`data-forge-src="src/App.tsx:5:5"`);
    expect(call(plugin.transform, APP, "/proj/node_modules/lib/App.tsx")).toBeNull();
    expect(call(plugin.transform, "export const a = 1", "/proj/src/a.ts")).toBeNull();
  });

  it("injects the inspector into index.html", () => {
    const tags = call(plugin.transformIndexHtml, "<html></html>", {}) as Array<{ tag: string; children: string }>;
    expect(tags[0]?.tag).toBe("script");
    expect(tags[0]?.children).toBe(INSPECTOR_SCRIPT);
    const off = forgeSourceTags({ inspector: false });
    expect(call(off.transformIndexHtml, "<html></html>", {})).toEqual([]);
  });
});

describe("Babel plugin", () => {
  const run = (code: string, opts: Record<string, unknown> = {}) =>
    transformSync(code, {
      filename: "/repo/src/App.tsx",
      cwd: "/repo",
      babelrc: false,
      configFile: false,
      parserOpts: { plugins: ["jsx", "typescript"] },
      plugins: [[forgeSourceTagsBabel, opts]],
    })!.code!;

  it("adds data-forge-src to host elements", () => {
    const out = run(APP);
    expect(out).toContain(`<main className="p-4" data-forge-src="src/App.tsx:5:5">`);
    expect(out).toContain(`<h1 data-forge-src="src/App.tsx:6:7">Hello</h1>`);
    expect(out).not.toMatch(/<Card[^>]*data-forge-src/);
    expect(out.match(/data-forge-src="keep:1:1"/g)?.length).toBe(1);
  });

  it("is disabled in production or when asked", () => {
    expect(run(APP, { enabled: false })).not.toContain("src/App.tsx:5:5");
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(run(APP)).not.toContain("src/App.tsx:5:5");
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it("agrees with the Vite transform on positions", () => {
    const babelSrcs = [...run(APP).matchAll(/data-forge-src="(src\/[^"]+)"/g)].map((m) => m[1]).sort();
    const viteSrcs = [...tagJsxSource(APP, "src/App.tsx")!.code.matchAll(/data-forge-src="(src\/[^"]+)"/g)].map((m) => m[1]).sort();
    expect(babelSrcs).toEqual(viteSrcs);
  });
});
