import { describe, expect, it } from "vitest";
import { extractLinks, prettyJson, scalarFields } from "../src/lib/evidence.js";

describe("evidence helpers", () => {
  const ev = {
    url: "https://login-micros0ft.example/verify",
    score: 0.97,
    matches: [{ note: "form posts to http://evil.example/collect, see also https://login-micros0ft.example/verify." }],
    nested: { deep: { html: "<a href='https://x.example/a'>x</a>" } },
  };
  it("extracts unique links recursively, stripping trailing punctuation", () => {
    expect(extractLinks(ev)).toEqual(["https://login-micros0ft.example/verify", "http://evil.example/collect", "https://x.example/a"]);
  });
  it("caps the number of links", () => {
    expect(extractLinks(Array.from({ length: 10 }, (_, i) => `https://a${i}.example`), 3)).toHaveLength(3);
  });
  it("returns scalar fields only", () => {
    expect(scalarFields(ev)).toEqual([
      ["url", "https://login-micros0ft.example/verify"],
      ["score", "0.97"],
    ]);
    expect(scalarFields(null)).toEqual([]);
    expect(scalarFields(["a"])).toEqual([]);
  });
  it("pretty prints and truncates", () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(prettyJson("x".repeat(100), 10)).toMatch(/more characters/);
    expect(prettyJson(undefined)).toBe("null");
  });
});
