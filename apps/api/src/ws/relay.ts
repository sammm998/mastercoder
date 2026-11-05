import type { Redis } from "ioredis";
import { randomBytes } from "node:crypto";
import type { CollabRelay } from "./collab.js";

/** Relays Yjs updates between API replicas over Redis pub/sub. */
export class RedisCollabRelay implements CollabRelay {
  private readonly instance = randomBytes(6).toString("hex");
  private handlers = new Map<string, Set<(u: Uint8Array) => void>>();
  constructor(
    private readonly pub: Redis,
    private readonly sub: Redis,
  ) {
    this.sub.on("messageBuffer", (channel: Buffer, msg: Buffer) => {
      const ch = channel.toString();
      const sep = msg.indexOf(0x7c); // "|"
      if (sep < 0 || msg.subarray(0, sep).toString() === this.instance) return;
      const update = new Uint8Array(msg.subarray(sep + 1));
      for (const h of this.handlers.get(ch) ?? []) h(update);
    });
  }
  publish(room: string, update: Uint8Array): void {
    void this.pub.publish(`forge:collab:${room}`, Buffer.concat([Buffer.from(`${this.instance}|`), Buffer.from(update)]));
  }
  subscribe(room: string, fn: (u: Uint8Array) => void): () => void {
    const ch = `forge:collab:${room}`;
    let set = this.handlers.get(ch);
    if (!set) {
      set = new Set();
      this.handlers.set(ch, set);
      void this.sub.subscribe(ch);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) {
        this.handlers.delete(ch);
        void this.sub.unsubscribe(ch);
      }
    };
  }
}
