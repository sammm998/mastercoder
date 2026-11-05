import { describe, it, expect } from "vitest";
import { MockLLMProvider } from "@forge/llm";
import { generateContent, mergeWithFallback, mockCopy, normalizeContent, SiteContentSchema } from "../src/index.js";
import { DesignBriefSchema } from "../src/types.js";

const briefIn = { name: "Remanis", description: "Remanis builds reliable industrial automation for Nordic manufacturers.", kind: "landing" as const };
const brief = DesignBriefSchema.parse(briefIn);
const good = mockCopy(brief);

describe("design.copy repair", () => {
  it("wraps a stats array into { items } and parses string values", () => {
    const n = normalizeContent({ ...good, stats: [{ value: "40%", label: "less downtime" }, { value: "n/a", label: "x" }] }) as { stats: { items: unknown[] } };
    expect(n.stats.items).toEqual([{ value: 40, suffix: "%", label: "less downtime" }]);
    expect(SiteContentSchema.safeParse(n).success).toBe(true);
  });

  it("keeps valid model sections and replaces only invalid ones with rule-based copy", () => {
    const modelOut = { ...good, hero: { ...good.hero, headline: "Automation that never sleeps" }, story: { title: "How", steps: [{ title: "Only one", body: "b" }] } };
    const { content, replaced } = mergeWithFallback(modelOut, good);
    expect(replaced).toEqual(["story"]);
    expect(content.hero.headline).toBe("Automation that never sleeps");
    expect(content.story.steps.length).toBeGreaterThanOrEqual(3);
    expect(content.generatedBy).toMatch(/rule-based fallback for: story/);
  });

  it("never throws: the exact failure seen in production (stats array + 2 story steps) still yields valid copy", async () => {
    let calls = 0;
    const bad = { ...good, stats: [{ value: 3, label: "plants" }], story: { title: "How", intro: "", steps: [{ title: "a", body: "b" }, { title: "c", body: "d" }] } };
    const llm = new MockLLMProvider().on("design.copy", () => {
      calls++;
      return JSON.stringify(bad);
    });
    let fellBack: string[] = [];
    const out = await generateContent(llm, briefIn, [], { onFallback: (r) => (fellBack = r) });
    expect(calls).toBe(3); // first try + 2 corrective retries
    expect(fellBack).toEqual(["story"]);
    expect(out.stats.items).toEqual([{ value: 3, label: "plants" }]);
    expect(SiteContentSchema.safeParse(out).success).toBe(true);
  });

  it("feeds readable field paths back to the model on retry", async () => {
    const seen: string[] = [];
    const llm = new MockLLMProvider().on("design.copy", (req) => {
      const last = req.messages[req.messages.length - 1];
      if (typeof last?.content === "string") seen.push(last.content);
      return seen.length === 1 ? JSON.stringify({ ...good, story: { title: "x", steps: [] } }) : JSON.stringify(good);
    });
    await generateContent(llm, briefIn);
    expect(seen[1]).toMatch(/- story\.steps: Array must contain at least 3/);
  });
});
