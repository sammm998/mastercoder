/**
 * WebSocket helpers: URL building, reconnect backoff and a small reconnecting client with injected
 * WebSocket constructor and timers (so it runs under vitest with a fake socket).
 */

/** http(s)://host[:port][/base] → ws(s)://host[:port][/base] + path. */
export function toWsUrl(apiUrl: string, path: string, query: Record<string, string | undefined> = {}): string {
  const u = new URL(apiUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  const basePath = u.pathname.replace(/\/$/, "");
  u.pathname = `${basePath}${path.startsWith("/") ? path : `/${path}`}`;
  u.search = "";
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") u.searchParams.set(k, v);
  return u.toString();
}

/**
 * The gateway authenticates WebSockets by cookie or `?token=` (it does not read the Authorization header),
 * so native clients pass the session token as a query parameter over TLS.
 */
export function eventsUrl(apiUrl: string, projectId: string, token: string | null): string {
  return toWsUrl(apiUrl, `/ws/events/${encodeURIComponent(projectId)}`, { token: token ?? undefined });
}

export function audioUrl(apiUrl: string, projectId: string, lang: "sv" | "en", token: string | null): string {
  return toWsUrl(apiUrl, `/ws/audio/${encodeURIComponent(projectId)}`, { lang, token: token ?? undefined });
}

/** Exponential backoff with full jitter: min(cap, base·2^attempt) · rand. */
export function backoffMs(attempt: number, opts: { baseMs?: number; capMs?: number; random?: () => number } = {}): number {
  const base = opts.baseMs ?? 500;
  const cap = opts.capMs ?? 15_000;
  const rand = opts.random ?? Math.random;
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt));
  return Math.round(Math.max(base / 2, exp * rand()));
}

/** Close codes the gateway uses for permanent failures: don't retry these. */
export const FATAL_CLOSE_CODES = new Set([4400, 4403, 4501]);

export interface SocketLike {
  readyState: number;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed" | "failed";

export interface ReconnectingSocketOptions {
  url: () => string;
  factory: SocketFactory;
  onMessage: (text: string) => void;
  onState?: (s: ConnectionState, info?: { code?: number; reason?: string }) => void;
  /** Called after every (re)connect, e.g. to re-fetch history missed while offline. */
  onOpen?: () => void;
  timers?: Timers;
  pingMs?: number;
  random?: () => number;
  maxAttempts?: number;
}

/** Keeps a socket open: pings, reconnects with backoff, stops on fatal close codes or close(). */
export class ReconnectingSocket {
  private ws: SocketLike | null = null;
  private attempt = 0;
  private stopped = false;
  private retryHandle: unknown = null;
  private pingHandle: unknown = null;
  private readonly timers: Timers;

  constructor(private readonly o: ReconnectingSocketOptions) {
    this.timers = o.timers ?? realTimers;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  /** Force a reconnect now (e.g. app returned to foreground or network came back). */
  kick(): void {
    if (this.stopped) return;
    if (this.ws && this.ws.readyState === 1) return;
    if (this.retryHandle) this.timers.clearTimeout(this.retryHandle);
    this.retryHandle = null;
    this.attempt = 0;
    this.connect();
  }

  send(text: string): boolean {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(text);
      return true;
    }
    return false;
  }

  close(): void {
    this.stopped = true;
    if (this.retryHandle) this.timers.clearTimeout(this.retryHandle);
    if (this.pingHandle) this.timers.clearInterval(this.pingHandle);
    this.retryHandle = this.pingHandle = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close(1000, "client closed");
    }
    this.o.onState?.("closed");
  }

  private connect() {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }
    this.o.onState?.(this.attempt === 0 ? "connecting" : "reconnecting");
    const ws = this.o.factory(this.o.url());
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.o.onState?.("open");
      if (this.pingHandle) this.timers.clearInterval(this.pingHandle);
      this.pingHandle = this.timers.setInterval(() => this.send(JSON.stringify({ type: "ping" })), this.o.pingMs ?? 25_000);
      this.o.onOpen?.();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") this.o.onMessage(ev.data);
    };
    ws.onerror = () => undefined;
    ws.onclose = (ev) => {
      if (this.pingHandle) this.timers.clearInterval(this.pingHandle);
      this.pingHandle = null;
      this.ws = null;
      if (this.stopped) return;
      if (FATAL_CLOSE_CODES.has(ev.code) || (this.o.maxAttempts !== undefined && this.attempt >= this.o.maxAttempts)) {
        this.stopped = true;
        this.o.onState?.("failed", { code: ev.code, reason: ev.reason });
        return;
      }
      const delay = backoffMs(this.attempt++, { random: this.o.random });
      this.o.onState?.("reconnecting", { code: ev.code, reason: ev.reason });
      this.retryHandle = this.timers.setTimeout(() => {
        this.retryHandle = null;
        this.connect();
      }, delay);
    };
  }
}
