import { describe, it, expect, afterAll } from "vitest";
import postgres from "postgres";
import { PgCloneBranchProvider } from "../src/index.js";

const admin = process.env.DATABASE_URL ?? "postgres://forge:forge@localhost:5432/forge";
const p = new PgCloneBranchProvider({ adminUrl: admin });
afterAll(() => p.close());

describe("per-project app database role", () => {
  it("gets a least-privilege login that owns only its own database", async () => {
    const db = `app_t${Date.now().toString(36)}`;
    const url = await p.ensureAppRole(db, `${db}_app`, "S3cure-Pass-For-Test-123");
    expect(await p.ensureAppRole(db, `${db}_app`, "S3cure-Pass-For-Test-123")).toBe(url);
    const app = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      await app`create table notes (id serial primary key, body text)`;
      await app`insert into notes (body) values ('hello')`;
      expect((await app`select body from notes`)[0]?.body).toBe("hello");
      const [r] = await app`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
      expect(r).toMatchObject({ rolsuper: false, rolbypassrls: false });
    } finally {
      await app.end();
    }
    const platform = new URL(url);
    platform.pathname = new URL(admin).pathname;
    const other = postgres(platform.toString(), { max: 1, onnotice: () => undefined });
    try {
      await expect(other`select count(*) from projects`).rejects.toThrow(/permission denied|does not exist/);
    } finally {
      await other.end();
    }
    await p.dropProject(db);
  });
});
