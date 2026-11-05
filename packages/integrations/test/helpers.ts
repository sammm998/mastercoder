import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Resolver } from "../src/index.js";

export type Handler = (req: IncomingMessage, res: ServerResponse, port: number) => void;

/** Local HTTP server on 127.0.0.1 with a route table (path -> handler). */
export async function startServer(routes: Record<string, Handler>): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const h = routes[path];
    if (!h) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    h(req, res, (server.address() as AddressInfo).port);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** Fake DNS: hostname -> addresses. */
export function fakeDns(map: Record<string, string[]>): Resolver {
  return async (host) => {
    const a = map[host];
    if (!a) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
}
