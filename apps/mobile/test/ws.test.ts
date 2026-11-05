import { describe, expect, it } from "vitest";
import { ReconnectingSocket, audioUrl, backoffMs, eventsUrl, toWsUrl, type SocketLike, type Timers } from "../src/lib/ws.js";

describe("URLs", () => {
  it("maps http(s) to ws(s) and keeps a base path", () => {
    expect(eventsUrl("https://api.forge.dev", "prj_1", "tok")).toBe("wss://api.forge.dev/ws/events/prj_1?token=tok");
    expect(toWsUrl("http://10.0.0.2:4000/api/", "/ws/x")).toBe("ws://10.0.0.2:4000/api/ws/x");
    expect(audioUrl("http://localhost:4000", "p 1", "sv", null)).toBe("ws://localhost:4000/ws/audio/p%201?lang=sv");
  });
});

describe("backoff", () => {
  it("grows exponentially and is capped", () => {
    const r = () => 1;
    expect(backoffMs(0, { random: r })).toBe(500);
    expect(backoffMs(3, { random: r })).toBe(4000);
    expect(backoffMs(20, { random: r })).toBe(15000);
    expect(backoffMs(0, { random: () => 0 })).toBe(250);
  });
});

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: unknown[] = [];
  onopen: SocketLike["onopen"] = null;
  onclose: SocketLike["onclose"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onerror: SocketLike["onerror"] = null;
  constructor(readonly url: string) {}
  send(d: string | ArrayBuffer | ArrayBufferView) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
}

function fakeTimers() {
  const timeouts: Array<{ fn: () => void; ms: number }> = [];
  const intervals: Array<{ fn: () => void; ms: number }> = [];
  const t: Timers = {
    setTimeout: (fn, ms) => timeouts.push({ fn, ms }),
    clearTimeout: () => undefined,
    setInterval: (fn, ms) => intervals.push({ fn, ms }),
    clearInterval: () => undefined,
  };
  return { t, timeouts, intervals };
}

describe("ReconnectingSocket", () => {
  it("delivers messages, pings, and reconnects after a drop", () => {
    const sockets: FakeSocket[] = [];
    const msgs: string[] = [];
    const states: string[] = [];
    let opens = 0;
    const { t, timeouts, intervals } = fakeTimers();
    const rs = new ReconnectingSocket({
      url: () => "ws://x",
      factory: (u) => {
        const s = new FakeSocket(u);
        sockets.push(s);
        return s;
      },
      onMessage: (m) => msgs.push(m),
      onState: (s) => states.push(s),
      onOpen: () => opens++,
      timers: t,
      random: () => 1,
    });
    rs.start();
    sockets[0]!.open();
    sockets[0]!.onmessage?.({ data: '{"type":"pong"}' });
    expect(msgs).toEqual(['{"type":"pong"}']);
    intervals[0]!.fn();
    expect(sockets[0]!.sent).toEqual(['{"type":"ping"}']);

    sockets[0]!.serverClose(1006);
    expect(states.at(-1)).toBe("reconnecting");
    expect(timeouts[0]!.ms).toBe(500);
    timeouts[0]!.fn();
    sockets[1]!.open();
    expect(opens).toBe(2);
    expect(states.at(-1)).toBe("open");
  });

  it("gives up on fatal close codes (auth/forbidden)", () => {
    const sockets: FakeSocket[] = [];
    const states: string[] = [];
    const { t, timeouts } = fakeTimers();
    const rs = new ReconnectingSocket({ url: () => "ws://x", factory: (u) => (sockets.push(new FakeSocket(u)), sockets.at(-1)!), onMessage: () => undefined, onState: (s) => states.push(s), timers: t });
    rs.start();
    sockets[0]!.serverClose(4403);
    expect(states.at(-1)).toBe("failed");
    expect(timeouts).toHaveLength(0);
  });

  it("close() stops reconnecting", () => {
    const sockets: FakeSocket[] = [];
    const { t, timeouts } = fakeTimers();
    const rs = new ReconnectingSocket({ url: () => "ws://x", factory: (u) => (sockets.push(new FakeSocket(u)), sockets.at(-1)!), onMessage: () => undefined, timers: t });
    rs.start();
    sockets[0]!.open();
    rs.close();
    expect(sockets[0]!.onclose).toBeNull();
    expect(timeouts).toHaveLength(0);
    expect(rs.send("x")).toBe(false);
  });
});
