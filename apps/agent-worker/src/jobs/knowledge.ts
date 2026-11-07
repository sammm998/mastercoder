import { eq, knowledgeChunks, knowledgeProfiles, knowledgeSources, chunkText, type Db } from "@forge/db";
import { getModels, textOf, type LLMProvider } from "@forge/llm";
import { newId } from "@forge/shared";
import { readPage } from "@forge/agent-core";

export const KNOWLEDGE_PROFILE_SYSTEM = `You write the company profile Scoutr uses as context whenever it builds something for this company.
From the source material, write a concise, factual profile in the material's language (markdown, max ~400 words):
- Company name, what it does, where it operates
- Products/services (with prices if stated)
- Target customers
- Tone of voice and brand cues (colours, fonts, slogans if visible)
- Contact details, opening hours, locations
- Other facts worth reusing (USPs, history, certifications)
Only use facts from the material. Never invent details; omit what is unknown.`;

/** Parse readPage() output into its text and same-site links. */
function parse(page: string): { title: string; text: string; links: string[] } {
  const title = /^Title: (.*)$/m.exec(page)?.[1] ?? "";
  const text = /Text:\n([\s\S]*?)(\n\n(Images|Pages on the site):|$)/.exec(page)?.[1] ?? "";
  const links = (/Pages on the site:\n([\s\S]*)$/.exec(page)?.[1] ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  return { title, text, links };
}

/** Crawl a website (same origin, up to `maxPages`) into knowledge chunks. */
export async function crawlInto(db: Db, src: { id: string; workspaceId: string; url: string }, maxPages = 40, read: (u: string) => Promise<string> = (u) => readPage(u)): Promise<number> {
  const start = new URL(src.url);
  const queue = [start.href];
  const seen = new Set(queue);
  let pages = 0;
  while (queue.length && pages < maxPages) {
    const url = queue.shift()!;
    const raw = await read(url).catch(() => null);
    if (!raw) continue;
    const p = parse(raw);
    const chunks = chunkText(p.text);
    if (chunks.length) {
      await db.insert(knowledgeChunks).values(chunks.map((content) => ({ id: newId("kc"), sourceId: src.id, workspaceId: src.workspaceId, url, title: p.title.slice(0, 200), content })));
      pages++;
      await db.update(knowledgeSources).set({ pages, updatedAt: new Date() }).where(eq(knowledgeSources.id, src.id));
    }
    for (const l of p.links) {
      const u = new URL(l);
      u.hash = "";
      if (u.origin === start.origin && !seen.has(u.href) && !/\.(png|jpe?g|webp|svg|pdf|zip|mp4)$/i.test(u.pathname)) {
        seen.add(u.href);
        queue.push(u.href);
      }
    }
  }
  return pages;
}

/** Rebuild the company profile from everything in the knowledge base. */
export async function refreshProfile(db: Db, llm: LLMProvider, workspaceId: string): Promise<string> {
  const rows = await db.select({ title: knowledgeChunks.title, url: knowledgeChunks.url, content: knowledgeChunks.content }).from(knowledgeChunks).where(eq(knowledgeChunks.workspaceId, workspaceId)).limit(60);
  let material = "";
  for (const r of rows) {
    const block = `## ${r.title}${r.url ? ` (${r.url})` : ""}\n${r.content}\n\n`;
    if (material.length + block.length > 30_000) break;
    material += block;
  }
  if (!material) {
    await db.delete(knowledgeProfiles).where(eq(knowledgeProfiles.workspaceId, workspaceId));
    return "";
  }
  const r = await llm.complete({ purpose: "knowledge.profile", model: getModels().fast, system: KNOWLEDGE_PROFILE_SYSTEM, messages: [{ role: "user", content: material }], maxTokens: 2000, effort: "low" });
  const profile = textOf(r).trim();
  const generatedBy = llm.isMock ? "mock (rule-based extract)" : "llm";
  await db.insert(knowledgeProfiles).values({ workspaceId, profile, generatedBy }).onConflictDoUpdate({ target: knowledgeProfiles.workspaceId, set: { profile, generatedBy, updatedAt: new Date() } });
  return profile;
}

/** Job: ingest one source (crawl a URL or chunk pasted text), then refresh the company profile. */
export async function runKnowledgeIngest(db: Db, llm: LLMProvider, sourceId: string): Promise<{ pages: number }> {
  const [src] = await db.select().from(knowledgeSources).where(eq(knowledgeSources.id, sourceId));
  if (!src) return { pages: 0 };
  await db.update(knowledgeSources).set({ status: "crawling", error: null, updatedAt: new Date() }).where(eq(knowledgeSources.id, src.id));
  try {
    let pages = 0;
    // Pasted text is chunked by the API when it is added; a URL is (re)crawled here.
    if (src.kind === "url" && src.url) {
      await db.delete(knowledgeChunks).where(eq(knowledgeChunks.sourceId, src.id));
      pages = await crawlInto(db, { id: src.id, workspaceId: src.workspaceId, url: src.url });
    }
    if (src.kind === "url" && pages === 0) throw new Error("No readable pages found at this address");
    await refreshProfile(db, llm, src.workspaceId);
    await db.update(knowledgeSources).set({ status: "ready", pages: src.kind === "url" ? pages : src.pages, updatedAt: new Date() }).where(eq(knowledgeSources.id, src.id));
    return { pages };
  } catch (e) {
    await db.update(knowledgeSources).set({ status: "failed", error: (e as Error).message.slice(0, 500), updatedAt: new Date() }).where(eq(knowledgeSources.id, src.id));
    throw e;
  }
}
