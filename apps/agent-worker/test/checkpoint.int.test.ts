import { describe, it, expect, afterAll } from "vitest";
import postgres from "postgres";
import { connect, runMigrations, eq, users, workspaces, projects, projectFiles, and } from "@forge/db";
import { newId } from "@forge/shared";
import { LocalSandboxProvider } from "@forge/sandbox";
import { PgCloneBranchProvider } from "@forge/app-kit";
import type { SandboxPort } from "@forge/agent-core";
import { createCheckpointing } from "../src/checkpoints.js";

const h = connect(undefined, 3);
const branches = new PgCloneBranchProvider({ adminUrl: process.env.DATABASE_ADMIN_URL || "postgres://forge:forge@localhost:5432/postgres" });
afterAll(async () => {
  await branches.close();
  await h.close();
});

describe("checkpoint restore (Definition of Done #4)", () => {
  it("restores both code and the app's database data", async () => {
    await runMigrations();
    const uid = newId("usr");
    const ws = newId("ws");
    const projectId = newId("prj");
    await h.db.insert(users).values({ id: uid, email: `${uid}@t.local` });
    await h.db.insert(workspaces).values({ id: ws, name: "w" });
    await h.db.insert(projects).values({ id: projectId, workspaceId: ws, name: "cp", createdBy: uid });

    const cps = createCheckpointing(h.db, branches);
    const sandbox = (await new LocalSandboxProvider().create({ projectId })) as unknown as SandboxPort;
    const root = (await cps.ensureProjectDb(projectId))!;
    const appDb = postgres(branches.urlFor(root), { max: 1, onnotice: () => undefined });
    await appDb`create table bookings (id serial primary key, customer text not null)`;
    await appDb`insert into bookings (customer) values ('Anna')`;
    await sandbox.writeFile("src/App.tsx", "export const version = 1;\n");

    const cp = await cps.create({ sandbox, projectId, label: "v1" });
    expect(cp.dbBranchId).toBeTruthy();
    expect(cp.commit).toMatch(/^[0-9a-f]{7,40}$/);

    // Later changes to code and data…
    await sandbox.writeFile("src/App.tsx", "export const version = 2;\n");
    await sandbox.writeFile("src/extra.ts", "export {};\n");
    await appDb`update bookings set customer = 'Mallory'`;
    await appDb`insert into bookings (customer) values ('Eve')`;
    await appDb.end();

    await cps.restore({ sandbox, projectId, checkpointId: cp.checkpointId });
    expect(await sandbox.readFile("src/App.tsx")).toBe("export const version = 1;\n");
    await expect(sandbox.readFile("src/extra.ts")).rejects.toThrow();
    const after = postgres(branches.urlFor(root), { max: 1, onnotice: () => undefined });
    const rows = await after`select customer from bookings order by id`;
    await after.end();
    expect(rows.map((r) => r.customer)).toEqual(["Anna"]);
    const [mirrored] = await h.db.select().from(projectFiles).where(and(eq(projectFiles.projectId, projectId), eq(projectFiles.path, "src/App.tsx")));
    expect(mirrored?.content).toBe("export const version = 1;\n");
  });
});
