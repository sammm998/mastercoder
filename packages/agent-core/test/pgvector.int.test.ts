import { describe, it, expect, afterAll } from "vitest";
import { connect, runMigrations } from "@forge/db";
import { PgVectorIndex, HashingEmbedder } from "../src/index.js";

const h = connect(undefined, 2);
afterAll(() => h.close());

describe("PgVectorIndex", () => {
  it("stores chunks in pgvector and searches by cosine distance", async () => {
    await runMigrations();
    const idx = new PgVectorIndex(h.db, new HashingEmbedder());
    const p = `prj_vec_${Date.now()}`;
    await idx.upsertFile(p, "src/auth/login.ts", "export async function login(email, password) { verifyPassword(password) }");
    await idx.upsertFile(p, "src/charts/revenue.tsx", "export function RevenueChart({ months }) { return <svg /> }");
    const hits = await idx.search(p, "password login check", 2);
    expect(hits[0]?.path).toBe("src/auth/login.ts");
    await idx.removeFile(p, "src/auth/login.ts");
    expect((await idx.search(p, "login", 5)).map((x) => x.path)).not.toContain("src/auth/login.ts");
  });
});
