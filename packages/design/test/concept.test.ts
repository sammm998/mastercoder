import { describe, it, expect } from "vitest";
import { MockLLMProvider } from "@forge/llm";
import { generateConcept, conceptToText, ruleConcept, curatedDirections } from "../src/index.js";
import { DesignBriefSchema } from "../src/types.js";

const bakery = { name: "Surdegsbagarn", description: "Hantverksbageri i Uppsala med surdegsbröd och kardemummabullar.", kind: "landing" as const };
const salon = { name: "Saxen", description: "Frisörsalong i Lund med klippning, färg och styling.", kind: "landing" as const };

describe("bespoke design concepts", () => {
  it("uses the model's concept, with its own sections, as the builder's layout brief", async () => {
    const dir = curatedDirections(DesignBriefSchema.parse(bakery))[0]!;
    const llm = new MockLLMProvider().on("design.concept", () =>
      JSON.stringify({ name: "Ugnsvarm", idea: "A bakery counter you scroll along", hero: "loaf cross-section photo with the name baked in", sections: [{ id: "today", purpose: "Today's bread", layout: "chalkboard list" }, { id: "oven", purpose: "Bake times", layout: "timeline" }, { id: "visit", purpose: "Visit", layout: "map + hours" }], signature: "steam rises on scroll", imagery: "flour, crust, hands", typography: "condensed serif", motion: "slow rise", avoid: ["bento grid"] }),
    );
    const c = await generateConcept(llm, bakery, dir);
    const text = conceptToText(c);
    expect(text).toMatch(/Design concept "Ugnsvarm"/);
    expect(text).toMatch(/1\. today — Today's bread\. Layout: chalkboard list/);
    expect(text).toMatch(/replaces the scaffold's default sections/);
  });
  it("falls back to a rule-based concept that differs between briefs", async () => {
    const dir = curatedDirections(DesignBriefSchema.parse(salon))[0]!;
    const bad = new MockLLMProvider().on("design.concept", () => "not json");
    const c = await generateConcept(bad, salon, dir);
    expect(c.generatedBy).toMatch(/fallback/);
    const names = new Set(["A", "B", "C", "D", "E", "F", "G", "H"].map((x) => ruleConcept({ ...salon, name: `Saxen ${x}` }, dir).hero));
    expect(names.size).toBeGreaterThan(1);
  });
});
