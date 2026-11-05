/**
 * Real local deploy with Docker: build the hono-api template's Dockerfile, run it, curl /health,
 * deploy v2 on the same preview URL, then roll back to v1.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localWriter, scaffold } from "@forge/templates";
import { LocalDeployProvider } from "../src/index.js";

const project = `it-${Math.random().toString(36).slice(2, 7)}`;
const provider = new LocalDeployProvider({ healthTimeoutMs: 90_000 });
let dir = "";

afterAll(async () => {
  await provider.destroy(project).catch(() => undefined);
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function health(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${url}/health`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe("LocalDeployProvider + docker", () => {
  it("deploys hono-api, deploys v2 on the same URL, rolls back to v1", async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-deploy-"));
    await scaffold("hono-api", localWriter(dir), { projectName: "Deploy Check" });

    const v1 = await provider.deploy({ projectId: project, dir, branch: "main", env: { APP_MARKER: "one" } });
    expect(v1.region).toBe("local");
    expect(await health(v1.url)).toMatchObject({ status: "ok", service: "deploy-check" });

    const appTs = join(dir, "src/app.ts");
    await writeFile(appTs, (await readFile(appTs, "utf8")).replace('c.json({ status: "ok",', 'c.json({ status: "ok", build: "v2",'));
    const v2 = await provider.deploy({ projectId: project, dir, branch: "main" });
    expect(v2.url).toBe(v1.url);
    expect(v2.deploymentId).not.toBe(v1.deploymentId);
    expect(await health(v2.url)).toMatchObject({ build: "v2" });

    const listed = await provider.listDeployments(project);
    expect(listed.map((d) => d.deploymentId)).toEqual(expect.arrayContaining([v1.deploymentId, v2.deploymentId]));

    const back = await provider.rollback(project, v1.deploymentId);
    expect(back.url).toBe(v1.url);
    const h = await health(back.url);
    expect(h.build).toBeUndefined();
    expect(h.status).toBe("ok");

    const logs = await provider.logs(v1.deploymentId);
    expect(logs.some((l) => l.includes("listening on"))).toBe(true);

    // Preview branches get their own URL.
    const preview = await provider.deploy({ projectId: project, dir, branch: "feature/x" });
    expect(preview.url).not.toBe(v1.url);
    expect(await health(preview.url)).toMatchObject({ build: "v2" });
  });
});
