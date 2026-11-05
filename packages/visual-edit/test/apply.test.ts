import { describe, it, expect } from "vitest";
import { applyVisualEdit, describeElement, cssPropToJs, VisualEditError, tagJsxSource, parseSrc } from "../src/index.js";

/** Find the 1-based (line, column) of the `<tag` occurrence `nth` in source. */
function at(source: string, needle: string, nth = 0) {
  let idx = -1;
  for (let i = 0; i <= nth; i++) idx = source.indexOf(needle, idx + 1);
  if (idx < 0) throw new Error(`needle ${needle} not found`);
  const before = source.slice(0, idx);
  const line = before.split("\n").length;
  const column = idx - before.lastIndexOf("\n");
  return { line, column };
}

const HERO = `import { useState } from "react";
import { cn } from "./lib/cn";

export default function Hero({ title }: { title: string }) {
  const [open, setOpen] = useState<boolean>(false);
  return (
    <section className="hero relative py-24" style={{ color: "#111", paddingTop: 24 }}>
      <h1 className='text-6xl font-bold'>
        Build anything
      </h1>
      <p>{"Ship it today"}</p>
      <p>{title}</p>
      <a href="/start" className={cn("btn", open && "btn-open")}>Get started</a>
      <img src="/hero.png" alt="Hero" />
      <span className={\`badge \${open ? "on" : "off"} small\`}>New</span>
      <button onClick={() => setOpen(!open)}>
        Toggle <strong>menu</strong>
      </button>
      <div />
    </section>
  );
}
`;

describe("applyVisualEdit: text", () => {
  it("replaces multi-line JSX text and keeps indentation", () => {
    const out = applyVisualEdit(HERO, at(HERO, "<h1"), { kind: "text", value: "Build faster" });
    expect(out).toContain("<h1 className='text-6xl font-bold'>\n        Build faster\n      </h1>");
    expect(out.replace("Build faster", "Build anything")).toBe(HERO);
  });

  it("replaces a string literal child, keeping its quotes", () => {
    const out = applyVisualEdit(HERO, at(HERO, "<p>"), { kind: "text", value: 'Say "hi"' });
    expect(out).toContain(`<p>{"Say \\"hi\\""}</p>`);
  });

  it("refuses dynamic text", () => {
    expect(() => applyVisualEdit(HERO, at(HERO, "<p>", 1), { kind: "text", value: "x" })).toThrow(VisualEditError);
    try {
      applyVisualEdit(HERO, at(HERO, "<p>", 1), { kind: "text", value: "x" });
    } catch (e) {
      expect((e as VisualEditError).code).toBe("DYNAMIC");
    }
  });

  it("edits the leading text of mixed content", () => {
    const out = applyVisualEdit(HERO, at(HERO, "<button"), { kind: "text", value: "Open" });
    expect(out).toContain("<button onClick={() => setOpen(!open)}>\n        Open <strong>menu</strong>");
  });

  it("escapes JSX-significant characters through an expression", () => {
    const out = applyVisualEdit(HERO, at(HERO, "<a href"), { kind: "text", value: "Go {now} <3" });
    expect(out).toContain(`>{"Go {now} <3"}</a>`);
  });

  it("expands a self-closing element to hold text", () => {
    const out = applyVisualEdit(HERO, at(HERO, "<div />"), { kind: "text", value: "Hello" });
    expect(out).toContain("<div >Hello</div>");
  });

  it("rejects text on void elements", () => {
    expect(() => applyVisualEdit(HERO, at(HERO, "<img"), { kind: "text", value: "x" })).toThrow(/cannot contain text/);
  });

  it("inserts text into an empty element", () => {
    const src = `const A = () => <p></p>;\n`;
    expect(applyVisualEdit(src, at(src, "<p>"), { kind: "text", value: "Filled" })).toBe(`const A = () => <p>Filled</p>;\n`);
  });

  it("output still parses", () => {
    const out = applyVisualEdit(HERO, at(HERO, "<h1"), { kind: "text", value: "a } b" });
    expect(() => tagJsxSource(out, "src/Hero.tsx")).not.toThrow();
  });
});

describe("applyVisualEdit: class", () => {
  it("adds and removes tokens in a string className", () => {
    const out = applyVisualEdit(HERO, at(HERO, "<section"), { kind: "class", add: ["py-32", "bg-ink"], remove: ["py-24"] });
    expect(out).toContain(`<section className="hero relative py-32 bg-ink"`);
  });

  it("keeps single quotes", () => {
    const out = applyVisualEdit(HERO, at(HERO, "<h1"), { kind: "class", add: ["tracking-tight"], remove: ["font-bold"] });
    expect(out).toContain(`<h1 className='text-6xl tracking-tight'>`);
  });

  it("does not duplicate an existing class", () => {
    const out = applyVisualEdit(HERO, at(HERO, "<section"), { kind: "class", add: ["hero"] });
    expect(out).toBe(HERO);
  });

  it("appends to cn() calls and strips from static args", () => {
    const out = applyVisualEdit(HERO, at(HERO, "<a href"), { kind: "class", add: ["btn-lg"], remove: ["btn"] });
    expect(out).toContain(`className={cn("", open && "btn-open", "btn-lg")}`);
  });

  it("edits template literal quasis around expressions", () => {
    const out = applyVisualEdit(HERO, at(HERO, "<span"), { kind: "class", add: ["rounded"], remove: ["small"] });
    expect(out).toContain('className={`badge ${open ? "on" : "off"} rounded`}');
  });

  it("adds a className attribute when missing", () => {
    const out = applyVisualEdit(HERO, at(HERO, "<img"), { kind: "class", add: ["w-full"] });
    expect(out).toContain(`<img src="/hero.png" alt="Hero" className="w-full" />`);
  });

  it("refuses identifier classNames", () => {
    const src = `const A = ({ c }: { c: string }) => <div className={c}>x</div>;`;
    expect(() => applyVisualEdit(src, at(src, "<div"), { kind: "class", add: ["a"] })).toThrow(/runtime/);
  });
});

describe("applyVisualEdit: style", () => {
  it("updates an existing property", () => {
    const out = applyVisualEdit(HERO, at(HERO, "<section"), { kind: "style", prop: "color", value: "#ff6a2b" });
    expect(out).toContain(`style={{ color: "#ff6a2b", paddingTop: 24 }}`);
  });

  it("accepts kebab-case and numbers", () => {
    const out = applyVisualEdit(HERO, at(HERO, "<section"), { kind: "style", prop: "padding-top", value: 48 });
    expect(out).toContain(`style={{ color: "#111", paddingTop: 48 }}`);
  });

  it("adds a property to an existing object", () => {
    const out = applyVisualEdit(HERO, at(HERO, "<section"), { kind: "style", prop: "background-color", value: "black" });
    expect(out).toContain(`style={{ color: "#111", paddingTop: 24, backgroundColor: "black" }}`);
  });

  it("adds a style attribute when missing", () => {
    const out = applyVisualEdit(HERO, at(HERO, "<h1"), { kind: "style", prop: "letterSpacing", value: "-0.02em" });
    expect(out).toContain(`<h1 className='text-6xl font-bold' style={{ letterSpacing: "-0.02em" }}>`);
  });

  it("removes properties (first, last, only)", () => {
    const first = applyVisualEdit(HERO, at(HERO, "<section"), { kind: "style", prop: "color", value: null });
    expect(first).toContain(`style={{ paddingTop: 24 }}`);
    const last = applyVisualEdit(HERO, at(HERO, "<section"), { kind: "style", prop: "paddingTop", value: "" });
    expect(last).toContain(`style={{ color: "#111" }}`);
    const only = applyVisualEdit(first, at(first, "<section"), { kind: "style", prop: "paddingTop", value: null });
    expect(only).toContain(`style={{}}`);
  });

  it("preserves multi-line object formatting", () => {
    const src = `export const C = () => (\n  <div\n    style={{\n      color: "red",\n      margin: 0,\n    }}\n  >\n    x\n  </div>\n);\n`;
    const out = applyVisualEdit(src, at(src, "<div"), { kind: "style", prop: "padding", value: "8px" });
    expect(out).toBe(`export const C = () => (\n  <div\n    style={{\n      color: "red",\n      margin: 0,\n      padding: "8px",\n    }}\n  >\n    x\n  </div>\n);\n`);
  });

  it("supports custom properties with quoted keys", () => {
    const out = applyVisualEdit(HERO, at(HERO, "<h1"), { kind: "style", prop: "--accent", value: "#f60" });
    expect(out).toContain(`style={{ "--accent": "#f60" }}`);
  });

  it("refuses computed style objects", () => {
    const src = `const s = {}; const A = () => <div style={s}>x</div>;`;
    expect(() => applyVisualEdit(src, at(src, "<div"), { kind: "style", prop: "color", value: "red" })).toThrow(/runtime/);
  });

  it("rejects invalid property names", () => {
    expect(() => applyVisualEdit(HERO, at(HERO, "<h1"), { kind: "style", prop: "color;x", value: "red" })).toThrow(/Invalid style/);
  });
});

describe("applyVisualEdit: attr", () => {
  it("replaces src and alt", () => {
    let out = applyVisualEdit(HERO, at(HERO, "<img"), { kind: "attr", name: "src", value: "https://cdn.example.eu/new.webp" });
    out = applyVisualEdit(out, at(out, "<img"), { kind: "attr", name: "alt", value: "A new hero" });
    expect(out).toContain(`<img src="https://cdn.example.eu/new.webp" alt="A new hero" />`);
  });

  it("adds a missing href", () => {
    const src = `const A = () => <a className="x">Link</a>;`;
    expect(applyVisualEdit(src, at(src, "<a"), { kind: "attr", name: "href", value: "/about" })).toBe(`const A = () => <a className="x" href="/about">Link</a>;`);
  });

  it("uses an expression when the value contains the quote", () => {
    const out = applyVisualEdit(HERO, at(HERO, "<img"), { kind: "attr", name: "alt", value: 'The "best" hero' });
    expect(out).toContain(`alt={"The \\"best\\" hero"}`);
  });

  it("replaces expression values", () => {
    const src = `const u = "/a"; const A = () => <a href={u}>x</a>;`;
    expect(applyVisualEdit(src, at(src, "<a"), { kind: "attr", name: "href", value: "/b" })).toBe(`const u = "/a"; const A = () => <a href="/b">x</a>;`);
  });
});

describe("element lookup", () => {
  it("finds an element by any position inside its opening tag", () => {
    const pos = at(HERO, "className='text-6xl");
    const out = applyVisualEdit(HERO, pos, { kind: "class", add: ["x"] });
    expect(out).toContain("<h1 className='text-6xl font-bold x'>");
  });

  it("throws NOT_FOUND outside any element", () => {
    expect(() => applyVisualEdit(HERO, { line: 1, column: 1 }, { kind: "text", value: "x" })).toThrow(/No JSX element/);
  });

  it("throws PARSE for broken source", () => {
    try {
      applyVisualEdit("const = <div", { line: 1, column: 1 }, { kind: "text", value: "x" });
      expect.unreachable();
    } catch (e) {
      expect((e as VisualEditError).code).toBe("PARSE");
    }
  });

  it("handles TypeScript generics and satisfies in .tsx", () => {
    const src = `type P<T> = { v: T };\nexport function L<T,>({ v }: P<T>) {\n  const x = { a: 1 } satisfies Record<string, number>;\n  return <ul>\n    <li>{String(v)}</li>\n    <li>Static</li>\n  </ul>;\n}\n`;
    const out = applyVisualEdit(src, at(src, "<li>", 1), { kind: "text", value: "Changed" });
    expect(out).toContain("<li>Changed</li>");
  });

  it("describes elements for the edit panel", () => {
    const info = describeElement(HERO, at(HERO, "<section"));
    expect(info).toMatchObject({ tag: "section", className: "hero relative py-24", style: { color: "#111", paddingTop: "24" } });
    expect(describeElement(HERO, at(HERO, "<h1")).text).toBe("Build anything");
    expect(describeElement(HERO, at(HERO, "<img")).attrs).toEqual({ src: "/hero.png", alt: "Hero" });
    expect(describeElement(HERO, at(HERO, "<p>", 1)).text).toBeNull();
  });

  it("round-trips with positions emitted by the source tagger", () => {
    const tagged = tagJsxSource(HERO, "src/Hero.tsx")!;
    const m = /<h1 data-forge-src="([^"]+)"/.exec(tagged.code)!;
    const loc = parseSrc(m[1]!)!;
    expect(loc.path).toBe("src/Hero.tsx");
    const out = applyVisualEdit(HERO, loc, { kind: "text", value: "Tagged" });
    expect(out).toContain("Tagged");
  });
});

describe("cssPropToJs", () => {
  it("camel-cases", () => {
    expect(cssPropToJs("border-top-left-radius")).toBe("borderTopLeftRadius");
    expect(cssPropToJs("--brand")).toBe("--brand");
    expect(cssPropToJs("color")).toBe("color");
  });
});
