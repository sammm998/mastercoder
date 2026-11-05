import type { WebSocketFactory, WebSocketLike } from "../src/adapters/ws.js";

/** In-memory WebSocket double: records what the adapter sends and lets the test play the server. */
export class FakeSocket implements WebSocketLike {
  sent: Array<string | Uint8Array> = [];
  isOpen = false;
  closedByClient: { code?: number; reason?: string } | undefined;
  private h = {
    open: [] as Array<() => void>,
    message: [] as Array<(d: string | Uint8Array) => void>,
    error: [] as Array<(e: Error) => void>,
    close: [] as Array<(c: number, r: string) => void>,
  };
  /** Called whenever the client sends; lets a test auto-respond (e.g. on CloseStream). */
  onClientSend: ((m: string | Uint8Array) => void) | undefined;
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}
  send(d: string | Uint8Array): void {
    if (!this.isOpen) throw new Error("send before open");
    this.sent.push(d);
    this.onClientSend?.(d);
  }
  close(code?: number, reason?: string): void {
    this.closedByClient = { code, reason };
    this.serverClose(code ?? 1000, reason ?? "");
  }
  onOpen(cb: () => void): void {
    this.h.open.push(cb);
  }
  onMessage(cb: (d: string | Uint8Array) => void): void {
    this.h.message.push(cb);
  }
  onError(cb: (e: Error) => void): void {
    this.h.error.push(cb);
  }
  onClose(cb: (c: number, r: string) => void): void {
    this.h.close.push(cb);
  }
  open(): void {
    this.isOpen = true;
    for (const cb of this.h.open) cb();
  }
  receive(msg: unknown): void {
    for (const cb of this.h.message) cb(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  serverClose(code = 1000, reason = ""): void {
    if (!this.isOpen && this.closedByClient === undefined && code !== 1000) return;
    this.isOpen = false;
    const cbs = this.h.close;
    this.h.close = [];
    for (const cb of cbs) cb(code, reason);
  }
  jsonSent(): Array<Record<string, unknown>> {
    return this.sent.filter((m): m is string => typeof m === "string").map((m) => JSON.parse(m) as Record<string, unknown>);
  }
}

export function fakeWsFactory(): { factory: WebSocketFactory; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    factory: (url, headers) => {
      const s = new FakeSocket(url, headers);
      sockets.push(s);
      return s;
    },
  };
}

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch stub returning `response` (JSON) and capturing requests. */
export function stubFetch(response: unknown, status = 200): { fetch: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url: String(input), method: init?.method ?? "GET", headers, body: init?.body });
    return new Response(typeof response === "string" ? response : JSON.stringify(response), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, calls };
}

export function silence(sec: number, rate = 16000): Uint8Array {
  return new Uint8Array(Math.round(sec * rate) * 2);
}

export const tick = () => new Promise((r) => setTimeout(r, 0));
