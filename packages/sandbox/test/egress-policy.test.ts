import { describe, expect, it } from "vitest";
import { checkIp, decide, embeddedIpv4, isBlockedHostname, matchesAllowlist, type LookupFn } from "../src/egress-policy.js";

const fixed =
  (map: Record<string, string[]>): LookupFn =>
  async (h) => {
    const v = map[h];
    if (!v) throw new Error("ENOTFOUND");
    return v.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };

describe("checkIp", () => {
  it.each([
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["127.0.0.1", "loopback"],
    ["169.254.169.254", "link-local/metadata"],
    ["0.0.0.0", "this-network"],
    ["100.64.0.1", "carrier-grade-nat"],
    ["224.0.0.1", "multicast"],
    ["::1", "loopback"],
    ["fc00::1", "unique-local"],
    ["fd12:3456::1", "unique-local"],
    ["fe80::1", "link-local"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:7f00:1", "loopback"],
    ["::ffff:169.254.169.254", "link-local/metadata"],
    ["64:ff9b::a9fe:a9fe", "link-local/metadata"],
    ["[::1]", "loopback"],
  ])("%s is blocked (%s)", (ip, reason) => {
    expect(checkIp(ip)).toEqual({ blocked: true, reason });
  });

  it.each(["8.8.8.8", "104.16.0.34", "172.32.0.1", "2606:4700::6810:22", "::ffff:8.8.8.8"])("%s is public", (ip) => {
    expect(checkIp(ip).blocked).toBe(false);
  });

  it("treats non-IPs as blocked", () => {
    expect(checkIp("example.com").blocked).toBe(true);
  });

  it("extracts embedded IPv4", () => {
    expect(embeddedIpv4("::ffff:10.0.0.1")).toBe("10.0.0.1");
    expect(embeddedIpv4("::ffff:0a00:0001")).toBe("10.0.0.1");
    expect(embeddedIpv4("2001:db8::1")).toBeNull();
  });
});

describe("hostnames and allowlist", () => {
  it("blocks metadata and internal names", () => {
    for (const h of ["metadata.google.internal", "METADATA.GOOGLE.INTERNAL.", "instance-data", "localhost", "foo.localhost", "db.svc.cluster.local", "host.docker.internal", "x.internal"]) {
      expect(isBlockedHostname(h), h).toBe(true);
    }
    expect(isBlockedHostname("registry.npmjs.org")).toBe(false);
  });

  it("matches exact, wildcard, dot-prefix and ports", () => {
    const list = ["registry.npmjs.org", "*.githubusercontent.com", ".pypi.org", "api.example.com:8443"];
    expect(matchesAllowlist("registry.npmjs.org", 443, list)).toBe(true);
    expect(matchesAllowlist("REGISTRY.npmjs.org.", 80, list)).toBe(true);
    expect(matchesAllowlist("evil-registry.npmjs.org", 443, list)).toBe(false);
    expect(matchesAllowlist("registry.npmjs.org.evil.com", 443, list)).toBe(false);
    expect(matchesAllowlist("raw.githubusercontent.com", 443, list)).toBe(true);
    expect(matchesAllowlist("githubusercontent.com", 443, list)).toBe(false);
    expect(matchesAllowlist("pypi.org", 443, list)).toBe(true);
    expect(matchesAllowlist("files.pypi.org", 443, list)).toBe(true);
    expect(matchesAllowlist("registry.npmjs.org", 22, list)).toBe(false);
    expect(matchesAllowlist("api.example.com", 8443, list)).toBe(true);
    expect(matchesAllowlist("api.example.com", 443, list)).toBe(false);
  });
});

describe("decide", () => {
  const allow = ["registry.npmjs.org", "rebind.example", "mixed.example", "8.8.8.8"];

  it("allows allowlisted hosts that resolve to public IPs and returns the verified addresses", async () => {
    const d = await decide("registry.npmjs.org", 443, allow, fixed({ "registry.npmjs.org": ["104.16.0.34", "104.16.1.34"] }));
    expect(d).toEqual({ allowed: true, reason: "allowlisted", addresses: ["104.16.0.34", "104.16.1.34"] });
  });

  it("denies non-allowlisted hosts without resolving them", async () => {
    let looked = false;
    const d = await decide("example.org", 443, allow, async () => {
      looked = true;
      return [{ address: "93.184.216.34", family: 4 }];
    });
    expect(d.reason).toBe("not-allowlisted");
    expect(looked).toBe(false);
  });

  it("denies allowlisted names that resolve to private/metadata addresses (DNS rebinding)", async () => {
    expect((await decide("rebind.example", 443, allow, fixed({ "rebind.example": ["169.254.169.254"] }))).reason).toBe("blocked-ip:link-local/metadata");
    expect((await decide("mixed.example", 443, allow, fixed({ "mixed.example": ["8.8.4.4", "10.0.0.5"] }))).reason).toBe("blocked-ip:private");
  });

  it("checks IP literals even when allowlisted, and blocks metadata names even when allowlisted", async () => {
    expect((await decide("169.254.169.254", 80, ["169.254.169.254"], fixed({}))).reason).toBe("blocked-ip:link-local/metadata");
    expect((await decide("8.8.8.8", 443, allow, fixed({}))).allowed).toBe(true);
    expect((await decide("metadata.google.internal", 80, ["metadata.google.internal"], fixed({}))).reason).toBe("blocked-hostname");
  });

  it("fails closed when DNS fails", async () => {
    expect((await decide("registry.npmjs.org", 443, allow, fixed({}))).reason).toBe("dns-failed");
    expect((await decide("registry.npmjs.org", 0, allow, fixed({}))).reason).toBe("bad-target");
  });
});
