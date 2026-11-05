import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect } from "node:net";
import { verifyPreviewToken, createLogger } from "@forge/shared";

/**
 * Preview proxy: a separate origin (its own domain) that serves the live dev server of a project's
 * sandbox, so generated code never runs on the API or web origin.
 *
 *   GET /__forge/open?t=<signed token>  → sets an httpOnly cookie on this origin and redirects to "/"
 *   anything else                        → proxied to the token's target (HTTP + WebSocket upgrades for HMR)
 */
const log = createLogger({ service: "preview" });
const secret = process.env.AUTH_SECRET;
if (!secret) throw new Error("AUTH_SECRET is required for the preview proxy");
const COOKIE = "forge_preview";

function cookieToken(req: IncomingMessage): string | null {
  const m = (req.headers.cookie ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

function page(res: ServerResponse, status: number, title: string, body: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title><body style="font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0;color:#555"><p>${body}</p></body></html>`);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://preview.local");
  if (url.pathname === "/__forge/health") return void res.end("ok");
  if (url.pathname === "/__forge/open") {
    const t = url.searchParams.get("t") ?? "";
    const claims = verifyPreviewToken(t, secret);
    if (!claims) return page(res, 403, "Preview expired", "This preview link is invalid or has expired. Open it again from the project.");
    res.writeHead(302, { location: "/", "set-cookie": `${COOKIE}=${encodeURIComponent(t)}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${Math.max(60, claims.exp - Math.floor(Date.now() / 1000))}` });
    return void res.end();
  }
  const claims = verifyPreviewToken(cookieToken(req) ?? "", secret);
  if (!claims) return page(res, 403, "No preview", "No active preview. Open the preview from your project.");
  const target = new URL(claims.target);
  // Never forward this origin's cookies (the preview token) to the generated app.
  const { cookie: _cookie, ...fwd } = req.headers;
  const upstream = httpRequest(
    { host: target.hostname, port: target.port || 80, method: req.method, path: url.pathname + url.search, headers: { ...fwd, host: target.host } },
    (up) => {
      const headers = { ...up.headers };
      delete headers["content-security-policy"];
      res.writeHead(up.statusCode ?? 502, headers);
      up.pipe(res);
    },
  );
  upstream.on("error", (e) => page(res, 502, "Starting…", `The app is starting (or the dev server stopped): ${e.message}. Reload in a moment.`));
  req.pipe(upstream);
});

// WebSocket upgrades (Vite / Next HMR).
server.on("upgrade", (req, socket, head) => {
  const claims = verifyPreviewToken(cookieToken(req) ?? "", secret);
  if (!claims) return socket.destroy();
  const target = new URL(claims.target);
  const up = netConnect(Number(target.port || 80), target.hostname, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries({ ...req.headers, host: target.host }).filter(([k]) => k !== "cookie").map(([k, v]) => `${k}: ${String(v)}`), "", ""];
    up.write(lines.join("\r\n"));
    if (head.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

const port = Number(process.env.PORT || 4100);
// Dual-stack where available (Railway's private network is IPv6); fall back to IPv4-only hosts.
server.once("error", (e: NodeJS.ErrnoException) => {
  if (e.code !== "EAFNOSUPPORT" && e.code !== "EADDRNOTAVAIL") throw e;
  server.listen(port, "0.0.0.0", () => log.info("preview proxy listening (ipv4)", { port }));
});
server.listen(port, "::", () => log.info("preview proxy listening", { port }));
