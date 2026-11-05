/**
 * Docker Postgres (localhost:5432, forge/forge). Backs Definition-of-Done #4: a checkpoint branch
 * restores the project's data. Also proves the kit's RLS helper SQL isolates rows per user.
 */
import { afterAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { KIT_ROOT, PgCloneBranchProvider } from "../src/index.js";

const ADMIN = process.env.DATABASE_ADMIN_URL ?? "postgres://forge:forge@localhost:5432/forge";
const suffix = Math.random().toString(36).slice(2, 8);
const ROOT = `forge_it_${suffix}`;
const provider = new PgCloneBranchProvider({ adminUrl: ADMIN });

afterAll(async () => {
  await provider.dropProject(ROOT).catch(() => undefined);
  await provider.dropProject(`${ROOT}_rls`).catch(() => undefined);
  await provider.close();
});

async function withDb<T>(url: string, fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

describe("PgCloneBranchProvider on docker Postgres", () => {
  it("branch → modify → restore brings the original data back", async () => {
    const mainUrl = await provider.createDatabase(ROOT);
    await withDb(mainUrl, async (sql) => {
      await sql`create table todos (id int primary key, title text not null)`;
      await sql`insert into todos values (1, 'original'), (2, 'keep me')`;
    });

    // An open app connection must not block branching (it is terminated).
    const appConn = postgres(mainUrl, { max: 1, onnotice: () => undefined });
    await appConn`select 1`;

    const { branchId, connectionUrl } = await provider.createBranch(ROOT, "before step 3");
    await appConn.end({ timeout: 1 }).catch(() => undefined);
    expect(branchId.startsWith(`${ROOT}__br_`)).toBe(true);
    expect(await withDb(connectionUrl, (sql) => sql`select title from todos order by id`)).toEqual([{ title: "original" }, { title: "keep me" }]);

    await withDb(mainUrl, async (sql) => {
      await sql`update todos set title = 'changed by agent' where id = 1`;
      await sql`delete from todos where id = 2`;
      await sql`create table extra (x int)`;
    });

    const listed = await provider.listBranches(ROOT);
    expect(listed.map((b) => ({ id: b.branchId, name: b.name }))).toEqual([{ id: branchId, name: "before step 3" }]);
    expect(listed[0]?.createdAt).toMatch(/^\d{4}-/);

    await provider.restoreBranch(ROOT, branchId);
    const rows = await withDb(mainUrl, (sql) => sql`select id, title from todos order by id`);
    expect(rows).toEqual([
      { id: 1, title: "original" },
      { id: 2, title: "keep me" },
    ]);
    const extra = await withDb(mainUrl, (sql) => sql`select to_regclass('public.extra') as t`);
    expect(extra[0]?.t).toBeNull();

    // The branch survives the restore and can be branched from again.
    const nested = await provider.createBranch(ROOT, "nested", branchId);
    expect((await provider.listBranches(ROOT)).length).toBe(2);
    await provider.deleteBranch(ROOT, nested.branchId);
    await provider.deleteBranch(ROOT, branchId);
    expect(await provider.listBranches(ROOT)).toEqual([]);
  });

  it("the kit RLS helper confines a non-superuser role to its own rows", async () => {
    const db = `${ROOT}_rls`;
    const url = await provider.createDatabase(db);
    const role = `forge_app_${suffix}`;
    const sqlFile = await readFile(join(KIT_ROOT, "common/db/drizzle/0000_forge_rls.sql"), "utf8");
    await withDb(url, async (sql) => {
      for (const stmt of sqlFile.split("--> statement-breakpoint")) await sql.unsafe(stmt);
      await sql`create table notes (id serial primary key, owner_id text not null, body text not null)`;
      await sql`select forge_enable_owner_rls('notes', 'owner_id')`;
      await sql.unsafe(`create role ${role} login password 'pw' nosuperuser nobypassrls`);
      await sql.unsafe(`grant usage on schema public to ${role}; grant select, insert, update, delete on notes to ${role}; grant usage on sequence notes_id_seq to ${role}`);
    });
    const appUrl = new URL(url);
    appUrl.username = role;
    appUrl.password = "pw";
    try {
      await withDb(appUrl.toString(), async (sql) => {
        // withUser(db, id, fn) does exactly this: set_config(..., true) inside a transaction.
        const as = (user: string, fn: (tx: postgres.TransactionSql) => Promise<unknown>) =>
          sql.begin(async (tx) => {
            await tx`select set_config('app.user_id', ${user}, true)`;
            return fn(tx);
          });
        await as("alice", (tx) => tx`insert into notes (owner_id, body) values ('alice', 'a1')`);
        await as("bob", (tx) => tx`insert into notes (owner_id, body) values ('bob', 'b1')`);
        expect(await as("alice", (tx) => tx`select body from notes`)).toEqual([{ body: "a1" }]);
        expect(await as("bob", (tx) => tx`select body from notes`)).toEqual([{ body: "b1" }]);
        // No user set → nothing visible; writing someone else's row is refused.
        expect(await sql`select count(*)::int as n from notes`).toEqual([{ n: 0 }]);
        await expect(as("alice", (tx) => tx`insert into notes (owner_id, body) values ('bob', 'forged')`)).rejects.toThrow(/row-level security/);
        expect(await as("alice", (tx) => tx`update notes set body = 'hacked' where owner_id = 'bob' returning id`)).toEqual([]);
      });
    } finally {
      await withDb(url, async (sql) => {
        await sql.unsafe(`drop owned by ${role}`);
      }).catch(() => undefined);
      await provider.dropProject(db);
      await withDb(ADMIN, (sql) => sql.unsafe(`drop role if exists ${role}`)).catch(() => undefined);
    }
  });
});
