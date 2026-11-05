import { createHash } from "node:crypto";
import { sql, fileEmbeddings, and, eq, type Db } from "@forge/db";
import { selectAdapter } from "@forge/shared";

export const EMBEDDING_DIM = 256;

export interface Embedder {
  readonly name: string;
  embed(texts: string[]): Promise<number[][]>;
}

/** Split identifiers (camelCase, snake_case, kebab) and words into lowercase tokens. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9åäöéü]+/)
    .filter((t) => t.length > 1 && t.length < 40);
}

/**
 * Local feature-hashing embedder (signed hashing trick over unigrams + bigrams, log-TF, L2-normalised).
 * Deterministic and offline; good for lexical/identifier similarity in code search. Use OpenAI embeddings
 * (EMBEDDING_PROVIDER=openai) for semantic similarity.
 */
export class HashingEmbedder implements Embedder {
  readonly name = "hashing";
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(EMBEDDING_DIM).fill(0);
      const toks = tokenize(t);
      const grams = [...toks, ...toks.slice(1).map((x, i) => `${toks[i]}_${x}`)];
      const tf = new Map<string, number>();
      for (const g of grams) tf.set(g, (tf.get(g) ?? 0) + 1);
      for (const [g, c] of tf) {
        const h = createHash("md5").update(g).digest();
        const idx = h.readUInt16BE(0) % EMBEDDING_DIM;
        const sign = (h[2] ?? 0) & 1 ? 1 : -1;
        v[idx] = (v[idx] ?? 0) + sign * (1 + Math.log(c));
      }
      const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
  }
}

/** OpenAI text-embedding-3-small truncated to 256 dimensions (Matryoshka). */
export class OpenAIEmbedder implements Embedder {
  readonly name = "openai";
  constructor(private readonly apiKey = process.env.OPENAI_API_KEY ?? "proxy-injected") {}
  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: "text-embedding-3-small", input: texts, dimensions: EMBEDDING_DIM }),
    });
    if (!res.ok) throw new Error(`OpenAI embeddings ${res.status}`);
    const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return data.data.map((d) => d.embedding);
  }
}

export function createEmbedder(): Embedder {
  return selectAdapter<Embedder>("EMBEDDING_PROVIDER", { hashing: () => new HashingEmbedder(), openai: () => new OpenAIEmbedder(), mock: () => new HashingEmbedder() }, "hashing").instance;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export interface Chunk {
  path: string;
  chunk: number;
  content: string;
}

/** Split a file into overlapping line windows prefixed with the path (helps path-based queries). */
export function chunkFile(path: string, source: string, lines = 60, overlap = 10): Chunk[] {
  const all = source.split("\n");
  const out: Chunk[] = [];
  for (let start = 0, i = 0; start < all.length; start += lines - overlap, i++) {
    out.push({ path, chunk: i, content: `// ${path}\n${all.slice(start, start + lines).join("\n")}` });
    if (start + lines >= all.length) break;
  }
  return out;
}

export interface SearchHit {
  path: string;
  chunk: number;
  score: number;
  preview: string;
}

export interface VectorIndex {
  upsertFile(projectId: string, path: string, source: string): Promise<void>;
  removeFile(projectId: string, path: string): Promise<void>;
  search(projectId: string, query: string, k?: number): Promise<SearchHit[]>;
}

export class MemoryVectorIndex implements VectorIndex {
  private rows: Array<Chunk & { projectId: string; v: number[] }> = [];
  constructor(private readonly embedder: Embedder = new HashingEmbedder()) {}
  async upsertFile(projectId: string, path: string, source: string) {
    await this.removeFile(projectId, path);
    const chunks = chunkFile(path, source);
    const vecs = await this.embedder.embed(chunks.map((c) => c.content));
    chunks.forEach((c, i) => this.rows.push({ ...c, projectId, v: vecs[i]! }));
  }
  async removeFile(projectId: string, path: string) {
    this.rows = this.rows.filter((r) => !(r.projectId === projectId && r.path === path));
  }
  async search(projectId: string, query: string, k = 8) {
    const [q] = await this.embedder.embed([query]);
    return this.rows
      .filter((r) => r.projectId === projectId)
      .map((r) => ({ path: r.path, chunk: r.chunk, score: cosine(q!, r.v), preview: r.content.slice(0, 300) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}

/** pgvector-backed index on the file_embeddings table (cosine distance). */
export class PgVectorIndex implements VectorIndex {
  constructor(
    private readonly db: Db,
    private readonly embedder: Embedder = new HashingEmbedder(),
  ) {}
  async upsertFile(projectId: string, path: string, source: string) {
    const chunks = chunkFile(path, source);
    const vecs = await this.embedder.embed(chunks.map((c) => c.content));
    await this.db.transaction(async (tx) => {
      await tx.delete(fileEmbeddings).where(and(eq(fileEmbeddings.projectId, projectId), eq(fileEmbeddings.path, path)));
      if (chunks.length)
        await tx.insert(fileEmbeddings).values(chunks.map((c, i) => ({ projectId, path, chunk: c.chunk, content: c.content, embedding: vecs[i]! })));
    });
  }
  async removeFile(projectId: string, path: string) {
    await this.db.delete(fileEmbeddings).where(and(eq(fileEmbeddings.projectId, projectId), eq(fileEmbeddings.path, path)));
  }
  async search(projectId: string, query: string, k = 8) {
    const [q] = await this.embedder.embed([query]);
    const vec = `[${q!.join(",")}]`;
    const rows = await this.db
      .select({ path: fileEmbeddings.path, chunk: fileEmbeddings.chunk, content: fileEmbeddings.content, distance: sql<number>`${fileEmbeddings.embedding} <=> ${vec}::vector`.mapWith(Number) })
      .from(fileEmbeddings)
      .where(eq(fileEmbeddings.projectId, projectId))
      .orderBy(sql`${fileEmbeddings.embedding} <=> ${vec}::vector`)
      .limit(k);
    return rows.map((r) => ({ path: r.path, chunk: r.chunk, score: 1 - r.distance, preview: r.content.slice(0, 300) }));
  }
}
