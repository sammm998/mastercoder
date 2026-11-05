import WebSocket from "ws";

/** The subset of a WebSocket the streaming adapters use; injectable for tests. */
export interface WebSocketLike {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onOpen(cb: () => void): void;
  /** `data` is a UTF-8 string for text frames and bytes for binary frames. */
  onMessage(cb: (data: string | Uint8Array) => void): void;
  onError(cb: (err: Error) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
  readonly isOpen: boolean;
}

export type WebSocketFactory = (url: string, headers: Record<string, string>) => WebSocketLike;

/** Default factory backed by the `ws` package (Node). */
export const nodeWebSocketFactory: WebSocketFactory = (url, headers) => {
  const ws = new WebSocket(url, { headers });
  return {
    send: (d) => ws.send(d),
    close: (code, reason) => ws.close(code, reason),
    onOpen: (cb) => void ws.on("open", cb),
    onMessage: (cb) =>
      void ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
        const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        cb(isBinary ? new Uint8Array(buf) : buf.toString("utf8"));
      }),
    onError: (cb) => void ws.on("error", cb),
    onClose: (cb) => void ws.on("close", (code: number, reason: Buffer) => cb(code, reason.toString("utf8"))),
    get isOpen() {
      return ws.readyState === WebSocket.OPEN;
    },
  };
};

/**
 * Wraps a WebSocketLike with an outbound queue (sends issued before `open` are buffered) and a
 * promise that settles when the socket closes.
 */
export class QueuedSocket {
  private queue: Array<string | Uint8Array> = [];
  private opened = false;
  readonly closed: Promise<{ code: number; reason: string }>;
  constructor(readonly ws: WebSocketLike) {
    ws.onOpen(() => {
      this.opened = true;
      for (const m of this.queue) ws.send(m);
      this.queue = [];
    });
    this.closed = new Promise((resolve) => ws.onClose((code, reason) => resolve({ code, reason })));
  }
  send(m: string | Uint8Array): void {
    if (this.opened && this.ws.isOpen) this.ws.send(m);
    else this.queue.push(m);
  }
}

/** Resolve after `ms`, or when `p` settles first. */
export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([p, t]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
