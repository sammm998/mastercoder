import { promises as dns, type LookupAddress, type LookupOptions } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP, isIPv4, isIPv6, type LookupFunction } from "node:net";
import { ForgeError } from "@forge/shared";

export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

export interface UrlPolicy {
  /** Allow private/loopback/link-local targets (self-hosted dev only). Default false. */
  allowPrivate?: boolean;
  /** Exact IP addresses allowed even though they are in a blocked range (tests, internal allowlists). */
  allowAddresses?: string[];
  /** DNS resolver (injectable for tests). Default: OS resolver, all addresses. */
  resolver?: Resolver;
}

export interface SafeFetchOptions extends UrlPolicy {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Max response body bytes (default 5 MiB). */
  maxBytes?: number;
  /** Overall deadline including redirects (default 10 s). */
  timeoutMs?: number;
  /** Max redirects; every hop is re-validated (default 3). */
  maxRedirects?: number;
}

const BLOCKED_HOSTNAMES = [/^localhost$/i, /\.localhost$/i, /^metadata(\.google\.internal)?$/i, /\.internal$/i, /\.local$/i, /^instance-data$/i];

const V4_BLOCKS: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}

function v4Blocked(ip: string): boolean {
  const n = v4ToInt(ip);
  return V4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) === (v4ToInt(base) & mask);
  });
}

/** Expand an IPv6 address into 8 16-bit groups (handles "::" and a trailing dotted IPv4). */
function v6Groups(ip: string): number[] {
  let s = ip.toLowerCase().split("%")[0]!;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = v4ToInt(v4[1]!);
    s = s.slice(0, -v4[1]!.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.includes("::") ? (s.split("::") as [string, string]) : [s, undefined];
  const h = head ? head.split(":").filter(Boolean) : [];
  const t = tail !== undefined ? tail.split(":").filter(Boolean) : [];
  const fill = tail !== undefined ? Array(8 - h.length - t.length).fill("0") : [];
  return [...h, ...fill, ...t].map((g) => Number.parseInt(g, 16));
}

function embeddedV4(hi: number, lo: number): string {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
}

function v6Blocked(ip: string): boolean {
  const g = v6Groups(ip);
  if (g.length !== 8 || g.some((x) => Number.isNaN(x))) return true;
  const zero5 = g.slice(0, 5).every((x) => x === 0);
  if (g.every((x) => x === 0)) return true; // ::
  if (zero5 && g[5] === 0 && g[6] === 0 && g[7] === 1) return true; // ::1
  if (zero5 && g[5] === 0xffff) return v4Blocked(embeddedV4(g[6]!, g[7]!)); // ::ffff:a.b.c.d
  if (zero5 && g[5] === 0) return v4Blocked(embeddedV4(g[6]!, g[7]!)); // ::a.b.c.d (deprecated compat)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4Blocked(embeddedV4(g[6]!, g[7]!)); // NAT64
  if (g[0] === 0x2002) return v4Blocked(embeddedV4(g[1]!, g[2]!)); // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo (obfuscated IPv4)
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation
  if (g[0] === 0x100 && g.slice(1, 4).every((x) => x === 0)) return true; // discard-only
  const first = g[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local (incl. AWS fd00:ec2::254)
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/** True for loopback, private, link-local, metadata, CGNAT, multicast, reserved and documentation ranges. */
export function isBlockedAddress(ip: string): boolean {
  if (isIPv4(ip)) return v4Blocked(ip);
  if (isIPv6(ip)) return v6Blocked(ip);
  return true;
}

function addressAllowed(ip: string, p: UrlPolicy): boolean {
  if (p.allowPrivate) return true;
  if (p.allowAddresses?.includes(ip)) return true;
  return !isBlockedAddress(ip);
}

function hostOf(u: URL): string {
  return u.hostname.replace(/^\[|\]$/g, "");
}

const defaultResolver: Resolver = (h) => dns.lookup(h, { all: true, verbatim: true });

/** Static checks: scheme, credentials, blocked hostnames and IP literals. */
function checkUrlShape(u: URL, p: UrlPolicy): void {
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new ForgeError("FORBIDDEN", `Blocked URL scheme "${u.protocol}" (only http/https)`);
  if (u.username || u.password) throw new ForgeError("FORBIDDEN", "URLs with embedded credentials are not allowed");
  const host = hostOf(u);
  if (!p.allowPrivate && BLOCKED_HOSTNAMES.some((r) => r.test(host))) throw new ForgeError("FORBIDDEN", `Blocked host "${host}"`);
  if (isIP(host) && !addressAllowed(host, p)) throw new ForgeError("FORBIDDEN", `Blocked address ${host} (private/loopback/link-local/metadata)`);
}

async function resolveChecked(host: string, p: UrlPolicy): Promise<LookupAddress[]> {
  if (isIP(host)) return [{ address: host, family: isIPv4(host) ? 4 : 6 }];
  let addrs: LookupAddress[];
  try {
    addrs = await (p.resolver ?? defaultResolver)(host);
  } catch (e) {
    throw new ForgeError("BAD_INPUT", `DNS lookup failed for ${host}: ${(e as Error).message}`);
  }
  if (addrs.length === 0) throw new ForgeError("BAD_INPUT", `No addresses for ${host}`);
  const bad = addrs.find((a) => !addressAllowed(a.address, p));
  if (bad) throw new ForgeError("FORBIDDEN", `Blocked address ${bad.address} for host ${host} (private/loopback/link-local/metadata)`);
  return addrs;
}

/**
 * Validate a URL for outbound use: http(s) only, no credentials, and every DNS answer must be public.
 * Use for clients that cannot route through `safeFetch` (e.g. long-lived MCP streams); `safeFetch` itself
 * additionally pins the checked addresses at connect time, closing the DNS-rebinding window.
 */
export async function assertPublicUrl(url: string | URL, p: UrlPolicy = {}): Promise<URL> {
  let u: URL;
  try {
    u = new URL(String(url));
  } catch {
    throw new ForgeError("BAD_INPUT", `Invalid URL: ${String(url).slice(0, 200)}`);
  }
  checkUrlShape(u, p);
  await resolveChecked(hostOf(u), p);
  return u;
}

/** dns lookup hook for http(s).request: resolves, rejects blocked answers, and connects only to checked IPs. */
function guardedLookup(p: UrlPolicy): LookupFunction {
  return ((hostname: string, options: LookupOptions, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
    resolveChecked(hostname, p).then(
      (addrs) => {
        const fam = options.family === 4 || options.family === 6 ? addrs.filter((a) => a.family === options.family) : addrs;
        const list = fam.length ? fam : addrs;
        if (options.all) cb(null, list);
        else cb(null, list[0]!.address, list[0]!.family);
      },
      (e: Error) => cb((e instanceof ForgeError ? e : Object.assign(e, { code: "ESSRFBLOCKED" })) as NodeJS.ErrnoException, options.all ? [] : ""),
    );
  }) as unknown as LookupFunction;
}

interface RawResponse {
  status: number;
  statusText: string;
  headers: Headers;
  body: Buffer;
}

function requestOnce(u: URL, o: SafeFetchOptions, deadline: number, maxBytes: number): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === "https:" ? https : http;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new ForgeError("BAD_INPUT", "Request timed out"));
    const req = lib.request(
      u,
      {
        method: o.method ?? "GET",
        headers: { "accept-encoding": "identity", "user-agent": "ForgeBot/1.0 (+integrations)", ...(o.headers ?? {}) },
        lookup: guardedLookup(o),
        agent: false,
      },
      (res) => {
        const len = Number(res.headers["content-length"] ?? "0");
        if (len > maxBytes) {
          res.destroy();
          return reject(new ForgeError("BAD_INPUT", `Response too large (${len} > ${maxBytes} bytes)`));
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          total += c.length;
          if (total > maxBytes) {
            res.destroy();
            reject(new ForgeError("BAD_INPUT", `Response exceeded ${maxBytes} bytes`));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          clearTimeout(timer);
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
            else if (v !== undefined) headers.set(k, String(v));
          }
          resolve({ status: res.statusCode ?? 0, statusText: res.statusMessage ?? "", headers, body: Buffer.concat(chunks) });
        });
        res.on("error", reject);
      },
    );
    const timer = setTimeout(() => req.destroy(new ForgeError("BAD_INPUT", `Request timed out after ${o.timeoutMs ?? 10_000} ms`)), remaining);
    req.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (e instanceof ForgeError) return reject(e);
      if (e.code === "ESSRFBLOCKED") return reject(new ForgeError("FORBIDDEN", e.message));
      reject(new ForgeError("BAD_INPUT", `Fetch failed for ${u.host}: ${e.message}`));
    });
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

/**
 * SSRF-hardened fetch for user-supplied URLs (OpenAPI specs, API docs, user API calls):
 * http(s) only, DNS answers checked and pinned at connect time, private/loopback/link-local/metadata
 * ranges blocked (incl. IPv4-mapped/NAT64/6to4 IPv6 forms), size limit, overall timeout, and every
 * redirect hop re-validated (Authorization/Cookie dropped on cross-origin hops).
 * Note: connects directly (ignores HTTP(S)_PROXY) because a proxy would defeat address pinning.
 */
export async function safeFetch(url: string | URL, o: SafeFetchOptions = {}): Promise<Response> {
  const maxBytes = o.maxBytes ?? 5 * 1024 * 1024;
  const deadline = Date.now() + (o.timeoutMs ?? 10_000);
  const maxRedirects = o.maxRedirects ?? 3;
  let current = new URL(String(url));
  let opts: SafeFetchOptions = { ...o };
  for (let hop = 0; ; hop++) {
    checkUrlShape(current, o);
    const r = await requestOnce(current, opts, deadline, maxBytes);
    const loc = r.headers.get("location");
    if ([301, 302, 303, 307, 308].includes(r.status) && loc) {
      if (hop >= maxRedirects) throw new ForgeError("BAD_INPUT", `Too many redirects (> ${maxRedirects})`);
      const next = new URL(loc, current);
      const method = (opts.method ?? "GET").toUpperCase();
      const toGet = r.status === 303 || ((r.status === 301 || r.status === 302) && method === "POST");
      const headers = { ...(opts.headers ?? {}) };
      if (next.origin !== current.origin) for (const k of Object.keys(headers)) if (/^(authorization|cookie|proxy-authorization)$/i.test(k)) delete headers[k];
      opts = { ...opts, headers, ...(toGet ? { method: "GET", body: undefined } : {}) };
      current = next;
      continue;
    }
    const nullBody = [101, 204, 205, 304].includes(r.status);
    const res = new Response(nullBody ? null : new Uint8Array(r.body), { status: r.status < 200 ? 200 : r.status, statusText: r.statusText, headers: r.headers });
    Object.defineProperty(res, "url", { value: current.toString() });
    return res;
  }
}

/** `typeof fetch`-compatible wrapper around safeFetch (for libraries that accept a custom fetch). */
export function makeSafeFetch(policy: Omit<SafeFetchOptions, "method" | "headers" | "body"> = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => (headers[k] = v));
    let body: string | Uint8Array | undefined;
    if (init?.body !== undefined && init.body !== null) {
      if (typeof init.body === "string") body = init.body;
      else {
        // FormData / URLSearchParams / Blob: let Response serialize it and supply the content-type (multipart boundary).
        const r = new Response(init.body);
        const ct = r.headers.get("content-type");
        if (ct && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["content-type"] = ct;
        body = new Uint8Array(await r.arrayBuffer());
      }
    }
    return safeFetch(url, { ...policy, method: init?.method ?? (input instanceof Request ? input.method : "GET"), headers, body });
  }) as typeof fetch;
}
