import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connect, runMigrations, users, workspaces, projects, eq, type DbHandle } from "../src/index.js";

let h: DbHandle;
beforeAll(async () => {
  await runMigrations();
  h = connect();
});
afterAll(async () => h?.close());

describe("db", () => {
  it("migrates and round-trips rows", async () => {
    const id = `usr_${Date.now()}`;
    await h.db.insert(users).values({ id, email: `${id}@test.local`, name: "T" });
    await h.db.insert(workspaces).values({ id: `ws_${id}`, name: "W" });
    await h.db.insert(projects).values({ id: `prj_${id}`, workspaceId: `ws_${id}`, name: "P", createdBy: id });
    const rows = await h.db.select().from(projects).where(eq(projects.workspaceId, `ws_${id}`));
    expect(rows).toHaveLength(1);
    const ext = await h.sql`select extname from pg_extension where extname = 'vector'`;
    expect(ext).toHaveLength(1);
  });
});
