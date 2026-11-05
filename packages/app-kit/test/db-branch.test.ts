import { afterEach, describe, expect, it, vi } from "vitest";
import { MockDbBranchProvider, NEON_EU_REGION, NeonBranchProvider, PgCloneBranchProvider, createDbBranchProvider } from "../src/index.js";

type Call = { method: string; url: string; body?: unknown };

function neonStub(routes: Record<string, (call: Call) => unknown>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? "GET", url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(" ");
      return m === call.method && new URL(call.url).pathname.endsWith(p as string);
    });
    if (!key) return new Response(JSON.stringify({ message: "no route" }), { status: 404 });
    return new Response(JSON.stringify((routes[key] as (c: Call) => unknown)(call)), { status: 200 });
  });
  return { calls, fetch: fetchImpl as unknown as typeof fetch };
}

describe("MockDbBranchProvider", () => {
  it("branches, restores and lists", async () => {
    const p = new MockDbBranchProvider();
    p.mainData("proj").set("row1", "original");
    const { branchId, connectionUrl } = await p.createBranch("proj", "before step 3");
    expect(connectionUrl).toMatch(/^mock:\/\//);
    p.mainData("proj").set("row1", "changed");
    await p.restoreBranch("proj", branchId);
    expect(p.mainData("proj").get("row1")).toBe("original");
    expect((await p.listBranches("proj")).map((b) => b.name)).toEqual(["before step 3"]);
    await p.deleteBranch("proj", branchId);
    expect(await p.listBranches("proj")).toEqual([]);
    await expect(p.restoreBranch("proj", "nope")).rejects.toThrow(/not found/);
    await expect(p.createBranch("proj", "bad/name")).rejects.toThrow();
  });

  it("is the default adapter", () => {
    expect(createDbBranchProvider().isMock).toBe(true);
  });
});

describe("NeonBranchProvider", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("requires an API key", () => {
    vi.stubEnv("NEON_API_KEY", "");
    expect(() => new NeonBranchProvider()).toThrow(/NEON_API_KEY/);
  });

  it("creates a branch with a read-write endpoint and returns its connection URI", async () => {
    const stub = neonStub({
      "POST /projects/prj_1/branches": () => ({
        branch: { id: "br_new", name: "checkpoint", parent_id: "br_main", created_at: "2026-11-05T00:00:00Z" },
        connection_uris: [{ connection_uri: "postgresql://u:p@ep-x.eu-central-1.aws.neon.tech/neondb" }],
        operations: [{ id: "op1", status: "finished" }],
      }),
    });
    const neon = new NeonBranchProvider({ apiKey: "k", fetch: stub.fetch });
    const r = await neon.createBranch("prj_1", "checkpoint", "br_main");
    expect(r).toEqual({ branchId: "br_new", connectionUrl: "postgresql://u:p@ep-x.eu-central-1.aws.neon.tech/neondb" });
    expect(stub.calls[0]?.body).toEqual({ branch: { name: "checkpoint", parent_id: "br_main" }, endpoints: [{ type: "read_write" }] });
  });

  it("restores the default branch from a branch and waits for the operation", async () => {
    let polls = 0;
    const stub = neonStub({
      "GET /projects/prj_1/branches": () => ({ branches: [{ id: "br_main", name: "main", default: true, created_at: "x" }, { id: "br_cp", name: "cp", parent_id: "br_main", created_at: "y" }] }),
      "POST /projects/prj_1/branches/br_main/restore": () => ({ operations: [{ id: "op9", status: "running" }] }),
      "GET /projects/prj_1/operations/op9": () => ({ operation: { id: "op9", status: ++polls > 1 ? "finished" : "running" } }),
    });
    const neon = new NeonBranchProvider({ apiKey: "k", fetch: stub.fetch, pollIntervalMs: 5 });
    await neon.restoreBranch("prj_1", "br_cp");
    const restore = stub.calls.find((c) => c.url.endsWith("/restore"));
    expect(restore?.body).toMatchObject({ source_branch_id: "br_cp" });
    expect((restore?.body as { preserve_under_name: string }).preserve_under_name).toMatch(/^pre-restore-/);
    expect(polls).toBe(2);
    expect(stub.calls.every((c) => c.url.startsWith("https://console.neon.tech/api/v2/"))).toBe(true);
  });

  it("creates projects in the EU region and maps API errors", async () => {
    const stub = neonStub({ "POST /projects": (c) => ({ project: { id: "prj_2", region_id: (c.body as { project: { region_id: string } }).project.region_id } }) });
    const neon = new NeonBranchProvider({ apiKey: "k", fetch: stub.fetch });
    await neon.createProject("site");
    expect((stub.calls[0]?.body as { project: { region_id: string } }).project.region_id).toBe(NEON_EU_REGION);
    await expect(neon.deleteBranch("prj_2", "missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("lists non-default branches with connection URIs", async () => {
    const stub = neonStub({
      "GET /projects/prj_1/branches": () => ({ branches: [{ id: "br_main", name: "main", default: true, created_at: "x" }, { id: "br_cp", name: "cp", parent_id: "br_main", created_at: "y" }] }),
      "GET /projects/prj_1/connection_uri": (c) => ({ uri: `postgresql://x/${new URL(c.url).searchParams.get("branch_id")}` }),
    });
    const list = await new NeonBranchProvider({ apiKey: "k", fetch: stub.fetch }).listBranches("prj_1");
    expect(list).toEqual([{ branchId: "br_cp", name: "cp", parentId: "br_main", createdAt: "y", connectionUrl: "postgresql://x/br_cp" }]);
  });
});

describe("PgCloneBranchProvider (no database needed)", () => {
  it("validates identifiers before touching Postgres", async () => {
    const p = new PgCloneBranchProvider({ adminUrl: "postgres://u:p@127.0.0.1:1/none" });
    await expect(p.createBranch('x"; drop database forge; --', "cp")).rejects.toThrow(/Invalid project database/);
    await expect(p.restoreBranch("proj_a", "proj_b__br_x_123456")).rejects.toThrow(/does not belong/);
    await expect(p.deleteBranch("proj_a", "other")).rejects.toThrow(/does not belong/);
    expect(p.urlFor("proj_a__br_cp_abc")).toBe("postgres://u:p@127.0.0.1:1/proj_a__br_cp_abc");
  });
});
