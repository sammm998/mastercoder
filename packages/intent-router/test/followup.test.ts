import { describe, it, expect } from "vitest";
import { followUpIntents } from "../src/index.js";

describe("follow-up prompts in an existing project", () => {
  it("treats 'analyse the site' in a website project as a website change, not a document", () => {
    const out = followUpIntents([{ kind: "document", confidence: 0.6, summary: "analyse" }], "please analyse remanis.se", { kind: "website", previousPrompts: ["Build me a new website for https://remanis.se/"] });
    expect(out.map((i) => i.kind)).toEqual(["website"]);
  });
  it("keeps explicit document requests and real questions", () => {
    const doc = [{ kind: "document" as const, confidence: 0.9, summary: "r" }];
    expect(followUpIntents(doc, "write a PDF report about the site", { kind: "website" })).toBe(doc);
    const q = [{ kind: "question" as const, confidence: 0.9, summary: "q" }];
    expect(followUpIntents(q, "what font does it use?", { kind: "website" })).toBe(q);
    expect(followUpIntents(doc, "analyse it", undefined)).toBe(doc);
  });
});
