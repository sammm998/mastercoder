import { describe, it, expect, afterAll } from "vitest";
import { connect, runMigrations, users, workspaces, knowledgeSources, knowledgeContext, searchKnowledge, getKnowledgeProfile } from "@forge/db";
import { MockLLMProvider } from "@forge/llm";
import { newId } from "@forge/shared";
import { crawlInto, refreshProfile } from "../src/jobs/knowledge.js";
import "../src/knowledge-mock.js";

const h = connect(undefined, 2);
afterAll(() => h.close());

const site: Record<string, string> = {
  "https://remanis.se/": "URL: https://remanis.se/\n\nTitle: Remanis\n\nText:\nRemanis bygger robotceller och PLC-automation för nordiska tillverkare. Vi har kontor i Göteborg och Jönköping.\n\nPages on the site:\nhttps://remanis.se/tjanster\nhttps://other.com/x",
  "https://remanis.se/tjanster": "URL: https://remanis.se/tjanster\n\nTitle: Tjänster\n\nText:\nVi erbjuder robotceller, PLC-programmering, serviceavtal och utbildning. Serviceavtal från 4 900 kr per månad.",
};

describe("company knowledge base (postgres)", () => {
  it("crawls same-site pages, builds a profile and gives relevant context for a request", async () => {
    await runMigrations();
    const uid = newId("usr");
    const ws = newId("ws");
    await h.db.insert(users).values({ id: uid, email: `${uid}@t.local` });
    await h.db.insert(workspaces).values({ id: ws, name: "w" });
    const id = newId("ks");
    await h.db.insert(knowledgeSources).values({ id, workspaceId: ws, kind: "url", title: "remanis.se", url: "https://remanis.se/", createdBy: uid });
    const pages = await crawlInto(h.db, { id, workspaceId: ws, url: "https://remanis.se/" }, 40, async (u) => {
      if (!site[u]) throw new Error("404");
      return site[u]!;
    });
    expect(pages).toBe(2);
    const profile = await refreshProfile(h.db, new MockLLMProvider(), ws);
    expect(profile).toMatch(/mock profile/);
    expect(await getKnowledgeProfile(h.db, ws)).toBe(profile);
    const hits = await searchKnowledge(h.db, ws, "Vad kostar ett serviceavtal?");
    expect(hits[0]?.content).toMatch(/4 900 kr/);
    const ctx = await knowledgeContext(h.db, ws, "Bygg en hemsida med våra tjänster och priser");
    expect(ctx).toMatch(/Company profile/);
    expect(ctx).toMatch(/serviceavtal/i);
    expect(await knowledgeContext(h.db, newId("ws"), "anything")).toBe("");
  });
});
