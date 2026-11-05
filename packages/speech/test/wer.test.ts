import { describe, it, expect } from "vitest";
import { cer, cerDetails, editCounts, normalizeText, tokenize, wer, werDetails } from "../src/wer.js";

describe("normalizeText", () => {
  it("lowercases, strips punctuation, unifies whitespace and keeps å/ä/ö", () => {
    expect(normalizeText("  Hej,   VÄRLDEN!\n Åsa  och Örjan?  ")).toBe("hej världen åsa och örjan");
    expect(normalizeText("Bygg en att-göra-app.")).toBe("bygg en att göra app");
    expect(normalizeText("Don’t stop – it's fine", { language: "en" })).toBe("don't stop it's fine");
  });
  it("optionally converts spelled-out numbers to digits (sv + en)", () => {
    expect(normalizeText("klockan åtta", { language: "sv", numbers: true })).toBe("klockan 8");
    expect(normalizeText("tjugotre bokningar", { language: "sv", numbers: true })).toBe("23 bokningar");
    expect(normalizeText("tvåhundrafemtio kronor", { language: "sv", numbers: true })).toBe("250 kronor");
    expect(normalizeText("etthundra", { language: "sv", numbers: true })).toBe("100");
    expect(normalizeText("tjugo tre", { language: "sv", numbers: true })).toBe("23");
    expect(normalizeText("fem sex sju", { language: "sv", numbers: true })).toBe("5 6 7");
    // Articles are not numbers.
    expect(normalizeText("en app och ett system", { language: "sv", numbers: true })).toBe("en app och ett system");
    expect(normalizeText("twenty-three apples", { language: "en", numbers: true })).toBe("23 apples");
    expect(normalizeText("two hundred and five", { language: "en", numbers: true })).toBe("205");
    expect(normalizeText("one thousand two hundred", { language: "en", numbers: true })).toBe("1200");
  });
});

describe("editCounts (Levenshtein)", () => {
  it("counts substitutions, deletions, insertions", () => {
    expect(editCounts(Array.from("kitten"), Array.from("sitting"))).toMatchObject({ substitutions: 2, deletions: 0, insertions: 1, hits: 4, n: 6 });
    expect(editCounts(["a", "b", "c"], [])).toMatchObject({ deletions: 3, insertions: 0, substitutions: 0 });
    expect(editCounts([], ["x", "y"])).toMatchObject({ insertions: 2, n: 0 });
  });
});

describe("wer", () => {
  it("matches hand-computed values", () => {
    expect(wer("the cat sat on the mat", "the cat sat on mat")).toBeCloseTo(1 / 6, 10);
    expect(wer("a b c d", "a x c d e")).toBeCloseTo(0.5, 10);
    expect(wer("Jag vill bygga en app", "jag ville bygga app", { language: "sv" })).toBeCloseTo(0.4, 10);
    expect(wer("one two", "three four five six")).toBe(2); // can exceed 1
  });
  it("ignores case and punctuation but not diacritics", () => {
    expect(wer("Hej, Världen!", "hej världen")).toBe(0);
    expect(wer("år", "ar")).toBe(1);
    expect(wer("Kunderna ska kunna boka.", "kunderna ska kunna boka")).toBe(0);
  });
  it("number normalization is opt-in", () => {
    expect(wer("klockan åtta", "klockan 8", { language: "sv" })).toBe(0.5);
    expect(wer("klockan åtta", "klockan 8", { language: "sv", numbers: true })).toBe(0);
  });
  it("handles empty input", () => {
    expect(wer("", "")).toBe(0);
    expect(wer("", "något")).toBe(1);
    expect(wer("något", "")).toBe(1);
    expect(tokenize(" ,. ")).toEqual([]);
  });
  it("returns a breakdown", () => {
    const d = werDetails("a b c d", "a x c d e");
    expect(d).toMatchObject({ substitutions: 1, insertions: 1, deletions: 0, hits: 3, n: 4, rate: 0.5 });
  });
});

describe("cer", () => {
  it("matches hand-computed values", () => {
    expect(cer("abc", "abd")).toBeCloseTo(1 / 3, 10);
    expect(cer("kitten", "sitting")).toBeCloseTo(0.5, 10);
    expect(cer("Hej då!", "hej då")).toBe(0);
    // "boka tid" (8 chars incl. space) vs "boka tiden" → 2 insertions
    expect(cerDetails("boka tid", "boka tiden")).toMatchObject({ insertions: 2, n: 8 });
  });
});
