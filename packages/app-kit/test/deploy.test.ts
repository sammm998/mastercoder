import { describe, expect, it, vi } from "vitest";
import { FlyDeployProvider, LocalDeployProvider, MockDeployProvider, createDeployProvider, type CommandRunner } from "../src/index.js";

describe("MockDeployProvider", () => {
  it("records deployments, rollbacks and domains with non-resolvable URLs", async () => {
    const d = new MockDeployProvider();
    const v1 = await d.deploy({ projectId: "Shop", image: "ghcr.io/x/shop:1", branch: "main" });
    const v2 = await d.deploy({ projectId: "Shop", image: "ghcr.io/x/shop:2", branch: "main" });
    expect(v1.url).toMatch(/\.mock\.forge\.invalid$/);
    expect(d.active.get("shop/main")).toBe(v2.deploymentId);
    await d.rollback("Shop", v1.deploymentId);
    expect(d.active.get("shop/main")).toBe(v1.deploymentId);
    const dom = await d.addDomain("Shop", "Shop.Example.EU.");
    expect(dom.hostname).toBe("shop.example.eu");
    expect((await d.logs(v1.deploymentId))[0]).toMatch(/\[mock\]/);
    await expect(d.addDomain("Shop", "not a host")).rejects.toThrow();
    await expect(d.deploy({ projectId: "Shop", branch: "main" })).rejects.toThrow(/exactly one of dir or image/);
    expect(createDeployProvider().isMock).toBe(true);
  });
});

describe("LocalDeployProvider (fake docker runner)", () => {
  it("builds with labels, proxy and CA secret, runs with a mapped port and waits for health", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = async (_cmd, args) => {
      calls.push(args);
      if (args[0] === "inspect") return { code: 1, stdout: "", stderr: "no such container" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const prev = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = "http://127.0.0.1:3128";
    try {
      const p = new LocalDeployProvider({ runner, buildCaFile: "/etc/hosts", healthTimeoutMs: 1000 });
      const r = await p.deploy({ projectId: "My Shop", dir: "/nonexistent", branch: "feature/login", port: 3000, healthPath: "/health", env: { FOO: "bar" } });
      expect(r.deploymentId).toMatch(/^my-shop--feature-login--v[a-z0-9]+$/);
      expect(r.url).toMatch(/^http:\/\/localhost:\d+$/);
      const build = calls.find((a) => a[0] === "build") as string[];
      expect(build).toEqual(expect.arrayContaining(["--label", "forge.project=my-shop", "--network", "host", "--build-arg", "HTTPS_PROXY=http://127.0.0.1:3128", "--secret", "id=ca,src=/etc/hosts"]));
      expect(build.at(-1)).toBe("/nonexistent");
      const run = calls.find((a) => a[0] === "run") as string[];
      expect(run).toEqual(expect.arrayContaining(["--name", "forge-my-shop-feature-login", "-e", "FOO=bar", "-e", "PORT=3000"]));
      expect(fetchSpy).toHaveBeenCalledWith(`${r.url}/health`, expect.anything());
    } finally {
      fetchSpy.mockRestore();
      if (prev === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = prev;
    }
  });

  it("parses deployment ids and refuses foreign rollbacks", async () => {
    expect(LocalDeployProvider.parseDeploymentId("shop--main--vabc123")).toEqual({ project: "shop", branch: "main", tag: "vabc123" });
    expect(() => LocalDeployProvider.parseDeploymentId("../etc")).toThrow();
    const p = new LocalDeployProvider({ runner: async () => ({ code: 0, stdout: "", stderr: "" }) });
    await expect(p.rollback("other", "shop--main--vabc123")).rejects.toThrow(/does not belong/);
  });

  it("rejects env keys that are not identifiers", async () => {
    const p = new LocalDeployProvider({ runner: async () => ({ code: 0, stdout: "", stderr: "" }) });
    await expect(p.deploy({ projectId: "x", image: "nginx", branch: "main", env: { "A B": "1" } })).rejects.toThrow(/identifiers/);
  });
});

function flyStub() {
  const calls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
  const machines = new Map<string, { id: string; region: string; config: Record<string, unknown> }>();
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, url: u.toString(), body });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    if (u.host === "api.fly.io" && u.pathname === "/graphql") {
      const q = String(body?.query);
      if (q.includes("addCertificate")) {
        const host = String((body?.variables as { hostname: string }).hostname);
        return json({ data: { addCertificate: { certificate: { hostname: host, clientStatus: "Awaiting configuration", configured: false, dnsValidationHostname: `_acme-challenge.${host}`, dnsValidationTarget: `${host}.x.flydns.net` } } } });
      }
      if (q.includes("ipAddresses")) return json({ data: { app: { ipAddresses: { nodes: [{ address: "66.241.124.1", type: "shared_v4" }, { address: "2a09:8280::1", type: "v6" }] } } } });
      return json({ data: { allocateIpAddress: { ipAddress: { address: "x", type: "v6" } } } });
    }
    const path = u.pathname.replace("/v1", "");
    if (method === "GET" && /^\/apps\/[^/]+$/.test(path)) return json({ error: "not found" }, 404);
    if (method === "POST" && path === "/apps") return json({});
    if (method === "GET" && /\/machines$/.test(path)) return json([...machines.values()]);
    if (method === "POST" && /\/machines$/.test(path)) {
      const m = { id: `m${machines.size + 1}`, region: String(body?.region), config: body?.config as Record<string, unknown> };
      machines.set(m.id, m);
      return json(m);
    }
    const upd = /\/machines\/([^/]+)$/.exec(path);
    if (method === "POST" && upd) {
      const m = machines.get(upd[1] as string);
      if (m) m.config = body?.config as Record<string, unknown>;
      return json(m);
    }
    if (/\/wait$/.test(path)) return json({ ok: true });
    return json({ error: `unhandled ${method} ${path}` }, 500);
  }) as typeof fetch;
  return { calls, machines, fetch: fetchImpl };
}

describe("FlyDeployProvider (stubbed fetch)", () => {
  it("only accepts EU regions", () => {
    expect(() => new FlyDeployProvider({ token: "t", region: "iad" })).toThrow(/EU region/);
    expect(new FlyDeployProvider({ token: "t", region: "fra" }).region).toBe("fra");
  });

  it("creates the app, allocates IPs, starts a machine in the EU and rolls back by image", async () => {
    const s = flyStub();
    const fly = new FlyDeployProvider({ token: "t", org: "forge", region: "arn", fetch: s.fetch });
    const v1 = await fly.deploy({ projectId: "Shop", image: "registry.fly.io/forge-shop:v1", branch: "main", port: 3000, healthPath: "/api/health" });
    expect(v1.url).toBe("https://forge-shop.fly.dev");
    expect(v1.region).toBe("arn");
    expect(s.calls.find((c) => c.url.endsWith("/v1/apps") && c.method === "POST")?.body).toEqual({ app_name: "forge-shop", org_slug: "forge" });
    expect(s.calls.filter((c) => String(c.body?.query ?? "").includes("allocateIpAddress"))).toHaveLength(2);
    const m = s.machines.get("m1");
    expect(m?.region).toBe("arn");
    expect(m?.config).toMatchObject({ image: "registry.fly.io/forge-shop:v1", env: { PORT: "3000" }, checks: { health: { path: "/api/health", port: 3000 } } });
    const v2 = await fly.deploy({ projectId: "Shop", image: "registry.fly.io/forge-shop:v2", branch: "main" });
    expect(s.machines.size).toBe(1);
    expect(s.machines.get("m1")?.config.image).toBe("registry.fly.io/forge-shop:v2");
    await fly.rollback("Shop", v1.deploymentId);
    expect(s.machines.get("m1")?.config.image).toBe("registry.fly.io/forge-shop:v1");
    expect(v2.deploymentId).not.toBe(v1.deploymentId);
    await expect(fly.rollback("Other", v1.deploymentId)).rejects.toThrow(/does not belong/);
  });

  it("gives previews their own app", () => {
    const fly = new FlyDeployProvider({ token: "t" });
    expect(fly.appName("Shop", "main")).toBe("forge-shop");
    expect(fly.appName("Shop", "feat/new-ui")).toBe("forge-shop-feat-new-ui");
  });

  it("returns routing + ACME DNS records for custom domains", async () => {
    const s = flyStub();
    const fly = new FlyDeployProvider({ token: "t", fetch: s.fetch });
    const sub = await fly.addDomain("Shop", "www.shop.eu");
    expect(sub.tlsStatus).toBe("pending");
    expect(sub.verification).toEqual([
      { type: "CNAME", name: "www.shop.eu", value: "forge-shop.fly.dev", purpose: "routing" },
      { type: "CNAME", name: "_acme-challenge.www.shop.eu", value: "www.shop.eu.x.flydns.net", purpose: "verification" },
    ]);
    const apex = await fly.addDomain("Shop", "shop.eu");
    expect(apex.verification.filter((r) => r.purpose === "routing").map((r) => r.type)).toEqual(["A", "AAAA"]);
  });

  it("pushes directory builds to registry.fly.io with docker", async () => {
    const s = flyStub();
    const cmds: string[][] = [];
    const runner: CommandRunner = async (_c, args) => {
      cmds.push(args);
      return { code: 0, stdout: "", stderr: "" };
    };
    const fly = new FlyDeployProvider({ token: "secret-token", fetch: s.fetch, runner });
    const r = await fly.deploy({ projectId: "Shop", dir: "/tmp/nonexistent-project", branch: "main" });
    expect(cmds.map((c) => c[0])).toEqual(["login", "build", "push"]);
    expect(cmds[0]).not.toContain("secret-token");
    expect(r.image).toMatch(/^registry\.fly\.io\/forge-shop:v/);
  });
});
