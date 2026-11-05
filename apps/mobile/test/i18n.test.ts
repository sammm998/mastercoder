import { describe, expect, it } from "vitest";
import { catalogs, createT, interpolate, leafKeys, pickLocale, placeholders, rawValue, translate } from "../src/lib/i18n.js";

describe("i18n catalogs", () => {
  const en = leafKeys(catalogs.en).sort();
  const sv = leafKeys(catalogs.sv).sort();

  it("Swedish and English have exactly the same keys", () => {
    expect(sv).toEqual(en);
  });

  it("every string is non-empty in both languages", () => {
    for (const k of en) {
      expect(translate("en", k).trim(), `en:${k}`).not.toBe("");
      expect(translate("sv", k).trim(), `sv:${k}`).not.toBe("");
    }
  });

  it("placeholders match between languages", () => {
    for (const k of en) expect(placeholders(rawValue("sv", k)), k).toEqual(placeholders(rawValue("en", k)));
  });

  it("Swedish is actually translated (not copied English) for most strings", () => {
    const same = en.filter((k) => rawValue("en", k) === rawValue("sv", k) && typeof rawValue("en", k) === "string");
    // Allowed identical strings: brand names, placeholders, language names.
    for (const k of same) expect(["app.name", "chat.forge", "chat.live", "chat.estimateRange", "signIn.pastePlaceholder", "settings.swedish", "settings.english", "chat.system", "settings.version"]).toContain(k);
  });
});

describe("translate", () => {
  it("interpolates params", () => {
    expect(translate("sv", "signIn.magicSent", { email: "a@b.se" })).toBe("Kolla a@b.se. Länken gäller i 15 minuter.");
    expect(interpolate("{a} {b}", { a: 1 })).toBe("1 {b}");
  });
  it("selects plural forms", () => {
    const t = createT("sv");
    expect(t("common.seconds", { count: 1 })).toBe("1 sekund");
    expect(t("common.seconds", { count: 5 })).toBe("5 sekunder");
    expect(translate("en", "common.seconds", { count: 0 })).toBe("0 seconds");
  });
  it("falls back to the key for unknown keys", () => {
    expect(translate("en", "nope.missing")).toBe("nope.missing");
  });
});

describe("pickLocale", () => {
  it("picks the first supported device language", () => {
    expect(pickLocale(["sv-SE", "en-US"])).toBe("sv");
    expect(pickLocale(["de-DE", "en-GB"])).toBe("en");
    expect(pickLocale(["fi-FI"])).toBe("en");
    expect(pickLocale([undefined, "sv_FI"])).toBe("sv");
  });
});
