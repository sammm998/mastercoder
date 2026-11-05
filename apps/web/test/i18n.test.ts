import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import en from "../messages/en.json";
import sv from "../messages/sv.json";
import { createTranslator, flattenKeys, format, lookup } from "../src/i18n/translate";
import { negotiateLocale } from "../src/i18n/config";

type Tree = Parameters<typeof flattenKeys>[0];
const enKeys = flattenKeys(en as Tree);
const svKeys = flattenKeys(sv as Tree);

/** Variable names used in a template: {name} and {count, plural, ...}. */
function vars(s: string): string[] {
  return [...s.matchAll(/\{(\w+)(?:,|\})/g)].map((m) => m[1]!).sort();
}

describe("message catalogs", () => {
  it("every English key exists in Swedish", () => {
    expect(enKeys.filter((k) => !svKeys.includes(k))).toEqual([]);
  });

  it("every Swedish key exists in English", () => {
    expect(svKeys.filter((k) => !enKeys.includes(k))).toEqual([]);
  });

  it("has no empty strings", () => {
    expect(enKeys.filter((k) => !lookup(en as Tree, k)?.trim())).toEqual([]);
    expect(svKeys.filter((k) => !lookup(sv as Tree, k)?.trim())).toEqual([]);
  });

  it("uses the same placeholders in both languages", () => {
    const mismatched = enKeys.filter((k) => JSON.stringify([...new Set(vars(lookup(en as Tree, k)!))]) !== JSON.stringify([...new Set(vars(lookup(sv as Tree, k) ?? ""))]));
    expect(mismatched).toEqual([]);
  });

  it("every literal t(\"…\") key used in the source exists", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(tsx?)$/.test(f)) files.push(p);
      }
    };
    walk(join(__dirname, "../src"));
    const used = new Set<string>();
    for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(/\bt\(\s*"([a-zA-Z][\w.-]*)"/g)) used.add(m[1]!);
    expect(used.size).toBeGreaterThan(200);
    expect([...used].filter((k) => !enKeys.includes(k))).toEqual([]);
  });
});

describe("formatter", () => {
  it("interpolates and pluralises per locale", () => {
    expect(format("Hi {name}", { name: "Ada" }, "en")).toBe("Hi Ada");
    const tpl = "{count, plural, =0 {none} one {# file} other {# files}}";
    expect(format(tpl, { count: 0 }, "en")).toBe("none");
    expect(format(tpl, { count: 1 }, "en")).toBe("1 file");
    expect(format(tpl, { count: 1200 }, "en")).toBe("1,200 files");
    expect(format(tpl, { count: 1200 }, "sv")).toBe("1 200 files");
    expect(format("{a} and {b}", { a: 1 }, "en")).toBe("1 and {b}");
  });

  it("supports nested variables inside plural branches", () => {
    expect(format("{count, plural, one {# by {who}} other {# by {who}}}", { count: 2, who: "Grace" }, "en")).toBe("2 by Grace");
  });

  it("translates real keys in both languages and falls back to the key", () => {
    expect(createTranslator(en, "en")("auth.login")).toBe("Log in");
    expect(createTranslator(sv, "sv")("auth.login")).toBe("Logga in");
    expect(createTranslator(sv, "sv")("project.code.editingNow", { count: 2 })).toBe("2 personer redigerar");
    expect(createTranslator({}, "en")("auth.login")).toBe("auth.login");
  });
});

describe("locale negotiation", () => {
  it("prefers the cookie, then Accept-Language q-values, then English", () => {
    expect(negotiateLocale("sv", "en-US")).toBe("sv");
    expect(negotiateLocale(undefined, "sv-SE,sv;q=0.9,en;q=0.8")).toBe("sv");
    expect(negotiateLocale(undefined, "de-DE,en;q=0.5,sv;q=0.7")).toBe("sv");
    expect(negotiateLocale(undefined, "fi-FI, sv-FI;q=0.6")).toBe("sv");
    expect(negotiateLocale("xx", "fr")).toBe("en");
    expect(negotiateLocale(null, null)).toBe("en");
    expect(negotiateLocale(undefined, "sv;q=0, en;q=0.1")).toBe("en");
  });
});
