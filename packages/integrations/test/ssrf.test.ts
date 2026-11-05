import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { assertPublicUrl, isBlockedAddress, makeSafeFetch, safeFetch } from "../src/index.js";
import { fakeDns, startServer } from "./helpers.js";

describe("isBlockedAddress", () => {
  const blocked = [
    "127.0.0.1",
    "127.255.255.254",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "198.18.0.1",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd00:ec2::254",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "ff02::1",
    "not-an-ip",
  ];
  const allowed = ["8.8.8.8", "1.1.1.1", "172.32.0.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8", "2a00:1450:4001:80b::200e"];
  it.each(blocked)("blocks %s", (ip) => expect(isBlockedAddress(ip)).toBe(true));
  it.each(allowed)("allows %s", (ip) => expect(isBlockedAddress(ip)).toBe(false));
});

describe("assertPublicUrl", () => {
  const resolver = fakeDns({ "good.test": ["93.184.216.34"], "evil.test": ["169.254.169.254"], "mixed.test": ["93.184.216.34", "10.0.0.7"], "v6.test": ["::1"] });
  it.each([
    ["file:///etc/passwd", /scheme/],
    ["ftp://good.test/x", /scheme/],
    ["gopher://good.test/", /scheme/],
    ["http://localhost:8080/", /Blocked host/],
    ["http://api.localhost/", /Blocked host/],
    ["http://metadata.google.internal/computeMetadata/v1/", /Blocked host/],
    ["http://user:pw@good.test/", /credentials/],
    ["http://127.0.0.1/", /Blocked address/],
    ["http://2130706433/", /Blocked address/],
    ["http://0x7f.1/", /Blocked address/],
    ["http://[::ffff:127.0.0.1]/", /Blocked address/],
    ["http://[::1]:3000/", /Blocked address/],
    ["http://169.254.169.254/latest/meta-data/", /Blocked address/],
    ["http://evil.test/", /169\.254\.169\.254/],
    ["http://mixed.test/", /10\.0\.0\.7/],
    ["http://v6.test/", /::1/],
  ])("rejects %s", async (url, msg) => {
    await expect(assertPublicUrl(url, { resolver })).rejects.toThrow(msg);
  });
  it("accepts public hosts and honours allowPrivate", async () => {
    await expect(assertPublicUrl("https://good.test/spec.json", { resolver })).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl("http://127.0.0.1:8080/", { allowPrivate: true })).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl("http://nxdomain.test/", { resolver })).rejects.toThrow(/DNS lookup failed/);
  });
});

describe("safeFetch", () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let port: number;
  const policy = () => ({
    resolver: fakeDns({ "public.test": ["127.0.0.1"], "other.test": ["127.0.0.1"], "internal.test": ["10.0.0.5"] }),
    allowAddresses: ["127.0.0.1"],
  });
  beforeAll(async () => {
    srv = await startServer({
      "/ok": (_q, r) => {
        r.setHeader("content-type", "application/json");
        r.end(JSON.stringify({ ok: true }));
      },
      "/big": (_q, r) => {
        r.setHeader("content-length", String(2 * 1024 * 1024));
        r.end(Buffer.alloc(2 * 1024 * 1024));
      },
      "/bigchunked": (_q, r) => {
        for (let i = 0; i < 40; i++) r.write(Buffer.alloc(64 * 1024));
        r.end();
      },
      "/slow": () => undefined,
      "/redir-meta": (_q, r) => {
        r.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/iam/" });
        r.end();
      },
      "/redir-internal": (_q, r, p) => {
        r.writeHead(301, { location: `http://internal.test:${p}/ok` });
        r.end();
      },
      "/redir-localhost": (_q, r, p) => {
        r.writeHead(302, { location: `http://localhost:${p}/ok` });
        r.end();
      },
      "/redir-file": (_q, r) => {
        r.writeHead(302, { location: "file:///etc/passwd" });
        r.end();
      },
      "/loop": (_q, r) => {
        r.writeHead(302, { location: "/loop" });
        r.end();
      },
      "/redir-other": (_q, r, p) => {
        r.writeHead(307, { location: `http://other.test:${p}/auth` });
        r.end();
      },
      "/redir-same": (_q, r) => {
        r.writeHead(303, { location: "/auth" });
        r.end();
      },
      "/auth": (q, r) => {
        r.setHeader("content-type", "application/json");
        r.end(JSON.stringify({ auth: q.headers.authorization ?? null, method: q.method }));
      },
    });
    port = srv.port;
  });
  afterAll(() => srv.close());

  it("fetches through the guard when the address is allowed", async () => {
    const r = await safeFetch(`http://public.test:${port}/ok`, policy());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(r.url).toBe(`http://public.test:${port}/ok`);
  });

  it("blocks loopback by default (literal and via DNS)", async () => {
    await expect(safeFetch(`http://127.0.0.1:${port}/ok`)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(safeFetch(`http://public.test:${port}/ok`, { resolver: fakeDns({ "public.test": ["127.0.0.1"] }) })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("re-validates every redirect hop", async () => {
    await expect(safeFetch(`http://public.test:${port}/redir-meta`, policy())).rejects.toThrow(/169\.254\.169\.254/);
    await expect(safeFetch(`http://public.test:${port}/redir-internal`, policy())).rejects.toThrow(/10\.0\.0\.5/);
    await expect(safeFetch(`http://public.test:${port}/redir-localhost`, policy())).rejects.toThrow(/Blocked host/);
    await expect(safeFetch(`http://public.test:${port}/redir-file`, policy())).rejects.toThrow(/scheme/);
    await expect(safeFetch(`http://public.test:${port}/loop`, policy())).rejects.toThrow(/Too many redirects/);
  });

  it("drops credentials on cross-origin redirects, keeps them same-origin, 303 -> GET", async () => {
    const cross = await safeFetch(`http://public.test:${port}/redir-other`, { ...policy(), headers: { authorization: "Bearer s3cret" } });
    expect(await cross.json()).toEqual({ auth: null, method: "GET" });
    const same = await safeFetch(`http://public.test:${port}/redir-same`, { ...policy(), method: "POST", body: "x", headers: { authorization: "Bearer s3cret" } });
    expect(await same.json()).toEqual({ auth: "Bearer s3cret", method: "GET" });
  });

  it("enforces size limits and timeouts", async () => {
    await expect(safeFetch(`http://public.test:${port}/big`, { ...policy(), maxBytes: 1024 * 1024 })).rejects.toThrow(/too large/);
    await expect(safeFetch(`http://public.test:${port}/bigchunked`, { ...policy(), maxBytes: 1024 * 1024 })).rejects.toThrow(/exceeded/);
    const t0 = Date.now();
    await expect(safeFetch(`http://public.test:${port}/slow`, { ...policy(), timeoutMs: 200 })).rejects.toThrow(/timed out/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("makeSafeFetch is fetch-compatible", async () => {
    const f = makeSafeFetch(policy());
    const r = await f(`http://public.test:${port}/auth`, { method: "POST", headers: { authorization: "Basic eA==" }, body: "{}" });
    expect(await r.json()).toEqual({ auth: "Basic eA==", method: "POST" });
    await expect(makeSafeFetch()(`http://127.0.0.1:${port}/ok`)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
