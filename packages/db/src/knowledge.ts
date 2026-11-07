import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { knowledgeChunks, knowledgeProfiles } from "./schema.js";

export interface KnowledgeHit {
  title: string;
  url: string | null;
  content: string;
}

/** Full-text search over a workspace's knowledge (any language: 'simple' config, OR of the query words). */
export async function searchKnowledge(db: Db, workspaceId: string, query: string, limit = 6): Promise<KnowledgeHit[]> {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, 24);
  if (!words.length) return [];
  const tsq = words.map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean).join(" | ");
  const doc = sql`to_tsvector('simple', ${knowledgeChunks.title} || ' ' || ${knowledgeChunks.content})`;
  const q = sql`to_tsquery('simple', ${tsq})`;
  return db
    .select({ title: knowledgeChunks.title, url: knowledgeChunks.url, content: knowledgeChunks.content })
    .from(knowledgeChunks)
    .where(and(eq(knowledgeChunks.workspaceId, workspaceId), sql`${doc} @@ ${q}`))
    .orderBy(desc(sql`ts_rank(${doc}, ${q})`))
    .limit(limit);
}

export async function getKnowledgeProfile(db: Db, workspaceId: string): Promise<string | null> {
  const [p] = await db.select({ profile: knowledgeProfiles.profile }).from(knowledgeProfiles).where(eq(knowledgeProfiles.workspaceId, workspaceId));
  return p?.profile ?? null;
}

/**
 * Company context for anything Scoutr creates: the profile (always) plus the passages most relevant to
 * the request. Empty string when the workspace has no knowledge base.
 */
export async function knowledgeContext(db: Db, workspaceId: string, request: string, maxChars = 7000): Promise<string> {
  const [profile, hits] = await Promise.all([getKnowledgeProfile(db, workspaceId), searchKnowledge(db, workspaceId, request, 6).catch(() => [])]);
  if (!profile && !hits.length) return "";
  const parts: string[] = [];
  if (profile) parts.push(`### Company profile\n${profile.slice(0, 3000)}`);
  let used = parts.join("").length;
  const passages: string[] = [];
  for (const h of hits) {
    const block = `- ${h.title}${h.url ? ` (${h.url})` : ""}: ${h.content.slice(0, 1200)}`;
    if (used + block.length > maxChars) break;
    passages.push(block);
    used += block.length;
  }
  if (passages.length) parts.push(`### Relevant facts from the knowledge base\n${passages.join("\n")}`);
  return parts.join("\n\n");
}

/** Split page text into ~1200-char chunks on sentence boundaries. */
export function chunkText(text: string, size = 1200): string[] {
  const sentences = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length + 1 > size) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur} ${s}` : s.slice(0, size * 2);
  }
  if (cur.trim()) out.push(cur);
  return out.filter((c) => c.length >= 40);
}
