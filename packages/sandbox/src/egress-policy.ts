/**
 * Egress policy used by the Forge egress proxy. Self-contained (node: imports only, erasable TypeScript only)
 * because the proxy container runs this file after type stripping, without node_modules.
 */
import { BlockList, isIP } from "node:net";

/** Ports allowed for allowlist entries that do not name a port. */
export const DEFAULT_ALLOWED_PORTS: readonly number[] = [80, 443];

/** Always denied, whatever the allowlist says. */
export const BLOCKED_IPV4: ReadonlyArray<readonly [string, number, string]> = [
  ["0.0.0.0", 8, "this-network"],
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "carrier-grade-nat"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local/metadata"],
  ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "ietf-protocol"],
  ["192.0.2.0", 24, "documentation"],
  ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "benchmarking"],
  ["198.51.100.0", 24, "documentation"],
  ["203.0.113.0", 24, "documentation"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"],
];

export const BLOCKED_IPV6: ReadonlyArray<readonly [string, number, string]> = [
  ["::", 128, "unspecified"],
  ["::1", 128, "loopback"],
  ["fc00::", 7, "unique-local"],
  ["fe80::", 10, "link-local"],
  ["fec0::", 10, "site-local"],
  ["ff00::", 8, "multicast"],
  ["2001:db8::", 32, "documentation"],
  ["100::", 64, "discard"],
];

/** Cloud metadata / internal hostnames that must never be proxied. */
export const BLOCKED_HOSTNAMES: readonly string[] = [
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "metadata.azure.com",
  "metadata.packet.net",
  "metadata.platformequinix.com",
  "instance-data",
  "instance-data.ec2.internal",
  "kubernetes.default",
  "kubernetes.default.svc",
  "host.docker.internal",
  "gateway.docker.internal",
  "localhost",
];

/** Hostname suffixes that are internal by definition. */
export const BLOCKED_SUFFIXES: readonly string[] = [
  ".internal",
  ".localhost",
  ".local",
  ".localdomain",
  ".svc.cluster.local",
  ".cluster.local",
  ".home.arpa",
];

const v4List = new BlockList();
for (const [net, prefix] of BLOCKED_IPV4) v4List.addSubnet(net, prefix, "ipv4");
const v6List = new BlockList();
for (const [net, prefix] of BLOCKED_IPV6) v6List.addSubnet(net, prefix, "ipv6");

function reasonFor(ip: string, family: "ipv4" | "ipv6"): string {
  const table = family === "ipv4" ? BLOCKED_IPV4 : BLOCKED_IPV6;
  for (const [net, prefix, reason] of table) {
    const one = new BlockList();
    one.addSubnet(net, prefix, family);
    if (one.check(ip, family)) return reason;
  }
  return "blocked";
}

/** Extract an embedded IPv4 address from IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible or NAT64 addresses. */
export function embeddedIpv4(ip: string): string | null {
  const lower = ip.toLowerCase();
  const m = /^(?:::ffff:(?:0:)?|::|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (m && m[1]) return m[1];
  const hex = /^(?:::ffff:(?:0:)?|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex && hex[1] && hex[2]) {
    const hi = Number.parseInt(hex[1], 16);
    const lo = Number.parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

export interface IpVerdict {
  blocked: boolean;
  reason: string;
}

/** True when the address is private, loopback, link-local (incl. 169.254.169.254), multicast or otherwise non-public. */
export function checkIp(ip: string): IpVerdict {
  const clean = ip.replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  const fam = isIP(clean);
  if (fam === 4) {
    if (v4List.check(clean, "ipv4")) return { blocked: true, reason: reasonFor(clean, "ipv4") };
    return { blocked: false, reason: "public" };
  }
  if (fam === 6) {
    const v4 = embeddedIpv4(clean);
    if (v4) return checkIp(v4);
    if (v6List.check(clean, "ipv6")) return { blocked: true, reason: reasonFor(clean, "ipv6") };
    return { blocked: false, reason: "public" };
  }
  return { blocked: true, reason: "not-an-ip" };
}

export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

export function isBlockedHostname(host: string): boolean {
  const h = normalizeHost(host);
  if (BLOCKED_HOSTNAMES.includes(h)) return true;
  return BLOCKED_SUFFIXES.some((s) => h.endsWith(s));
}

interface AllowEntry {
  host: string;
  wildcard: "none" | "subdomains" | "apex-and-subdomains";
  port: number | null;
}

function parseEntry(raw: string): AllowEntry | null {
  let e = raw.trim().toLowerCase();
  if (!e) return null;
  let port: number | null = null;
  const pm = /^(.*):(\d{1,5})$/.exec(e);
  if (pm && pm[1] !== undefined && pm[2] !== undefined && !pm[1].includes(":")) {
    e = pm[1];
    port = Number(pm[2]);
  }
  if (e.startsWith("*.")) return { host: normalizeHost(e.slice(2)), wildcard: "subdomains", port };
  if (e.startsWith(".")) return { host: normalizeHost(e.slice(1)), wildcard: "apex-and-subdomains", port };
  return { host: normalizeHost(e), wildcard: "none", port };
}

/** Allowlist match: `host` exact, `*.host` subdomains only, `.host` apex + subdomains; optional `:port`. */
export function matchesAllowlist(host: string, port: number, allowlist: readonly string[]): boolean {
  const h = normalizeHost(host);
  for (const raw of allowlist) {
    const e = parseEntry(raw);
    if (!e) continue;
    const portOk = e.port === null ? DEFAULT_ALLOWED_PORTS.includes(port) : e.port === port;
    if (!portOk) continue;
    if (e.wildcard === "none" && h === e.host) return true;
    if (e.wildcard !== "none" && h.endsWith("." + e.host)) return true;
    if (e.wildcard === "apex-and-subdomains" && h === e.host) return true;
  }
  return false;
}

export interface LookupAddress {
  address: string;
  family: number;
}
export type LookupFn = (host: string) => Promise<LookupAddress[]>;

export interface Decision {
  allowed: boolean;
  /** Machine-readable reason, e.g. "not-allowlisted", "blocked-ip:private". */
  reason: string;
  /** Verified public addresses to dial (empty when denied). */
  addresses: string[];
}

/**
 * Decide whether `host:port` may be reached. Order: blocked hostnames, IP literals (always checked), allowlist,
 * DNS resolution with every resolved address checked (no DNS rebinding: callers dial the returned addresses).
 */
export async function decide(host: string, port: number, allowlist: readonly string[], lookup: LookupFn): Promise<Decision> {
  const h = normalizeHost(host);
  if (!h || !Number.isInteger(port) || port < 1 || port > 65535) return { allowed: false, reason: "bad-target", addresses: [] };
  if (isBlockedHostname(h)) return { allowed: false, reason: "blocked-hostname", addresses: [] };
  if (isIP(h)) {
    const v = checkIp(h);
    if (v.blocked) return { allowed: false, reason: `blocked-ip:${v.reason}`, addresses: [] };
    if (!matchesAllowlist(h, port, allowlist)) return { allowed: false, reason: "not-allowlisted", addresses: [] };
    return { allowed: true, reason: "allowlisted", addresses: [h] };
  }
  if (!matchesAllowlist(h, port, allowlist)) return { allowed: false, reason: "not-allowlisted", addresses: [] };
  let addrs: LookupAddress[];
  try {
    addrs = await lookup(h);
  } catch {
    return { allowed: false, reason: "dns-failed", addresses: [] };
  }
  if (addrs.length === 0) return { allowed: false, reason: "dns-empty", addresses: [] };
  for (const a of addrs) {
    const v = checkIp(a.address);
    if (v.blocked) return { allowed: false, reason: `blocked-ip:${v.reason}`, addresses: [] };
  }
  return { allowed: true, reason: "allowlisted", addresses: addrs.map((a) => a.address) };
}
