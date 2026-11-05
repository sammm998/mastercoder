import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import { createBrotliCompress, createGzip, constants as zc } from "node:zlib";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
};
const COMPRESSIBLE = /^(text\/|application\/json|image\/svg)/;

export interface StaticServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Minimal production-like static server for built sites: brotli/gzip compression, immutable caching for
 * hashed /assets/, SPA fallback to index.html, path traversal protection.
 */
export async function serveStatic(dir: string, opts: { port?: number; host?: string } = {}): Promise<StaticServer> {
  const root = resolve(dir);
  const server: Server = createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]!.split("#")[0]!);
      let file = normalize(join(root, urlPath));
      if (file !== root && !file.startsWith(root + sep)) {
        res.writeHead(403).end("Forbidden");
        return;
      }
      if (!existsSync(file) || statSync(file).isDirectory()) {
        const idx = join(file, "index.html");
        file = existsSync(idx) ? idx : extname(urlPath) ? "" : join(root, "index.html");
      }
      if (!file || !existsSync(file)) {
        res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
        return;
      }
      const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
      const headers: Record<string, string> = {
        "content-type": type,
        "cache-control": urlPath.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
        "x-content-type-options": "nosniff",
      };
      const accept = String(req.headers["accept-encoding"] ?? "");
      const stream = createReadStream(file);
      if (COMPRESSIBLE.test(type) && /\bbr\b/.test(accept)) {
        res.writeHead(200, { ...headers, "content-encoding": "br", vary: "accept-encoding" });
        stream.pipe(createBrotliCompress({ params: { [zc.BROTLI_PARAM_QUALITY]: 5 } })).pipe(res);
      } else if (COMPRESSIBLE.test(type) && /\bgzip\b/.test(accept)) {
        res.writeHead(200, { ...headers, "content-encoding": "gzip", vary: "accept-encoding" });
        stream.pipe(createGzip()).pipe(res);
      } else {
        res.writeHead(200, { ...headers, "content-length": String(statSync(file).size) });
        stream.pipe(res);
      }
    } catch {
      res.writeHead(500).end("Server error");
    }
  });
  await new Promise<void>((ok) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://${opts.host ?? "127.0.0.1"}:${port}/`,
    port,
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}
