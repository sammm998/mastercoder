import type { Redis } from "ioredis";
import { events as eventsTable, type Db } from "@forge/db";
import { ForgeEventSchema, eventChannel, newId, type ForgeEvent, type ForgeEventInput } from "@forge/shared";
import type { EventPublisher } from "../deps.js";

function complete(e: ForgeEventInput): ForgeEvent {
  return ForgeEventSchema.parse({ ...e, id: newId("evt", 8), at: new Date().toISOString() });
}

async function persist(db: Db, e: ForgeEvent): Promise<void> {
  // Presence and streaming deltas are ephemeral; everything else is the durable project history.
  if (e.type === "presence" || e.type === "message.delta") return;
  await db.insert(eventsTable).values({ id: e.id, projectId: e.projectId, taskId: e.taskId ?? null, type: e.type, payload: e, at: new Date(e.at) });
}

/** Persists to Postgres and fans out over Redis pub/sub so every API replica's WebSockets see it. */
export class RedisEventPublisher implements EventPublisher {
  private handlers = new Map<string, Set<(e: ForgeEvent) => void>>();
  private ready: Promise<void>;
  constructor(
    private readonly db: Db,
    private readonly pub: Redis,
    private readonly sub: Redis,
  ) {
    this.ready = Promise.resolve();
    this.sub.on("message", (channel: string, msg: string) => {
      const set = this.handlers.get(channel);
      if (!set) return;
      const parsed = ForgeEventSchema.safeParse(JSON.parse(msg));
      if (parsed.success) for (const h of set) h(parsed.data);
    });
  }
  async publish(input: ForgeEventInput): Promise<ForgeEvent> {
    const e = complete(input);
    await persist(this.db, e);
    await this.pub.publish(eventChannel(e.projectId), JSON.stringify(e));
    return e;
  }
  async subscribe(projectId: string, fn: (e: ForgeEvent) => void): Promise<() => void> {
    await this.ready;
    const ch = eventChannel(projectId);
    let set = this.handlers.get(ch);
    if (!set) {
      set = new Set();
      this.handlers.set(ch, set);
      await this.sub.subscribe(ch);
    }
    set.add(fn);
    return () => {
      const s = this.handlers.get(ch);
      s?.delete(fn);
      if (s && s.size === 0) {
        this.handlers.delete(ch);
        void this.sub.unsubscribe(ch);
      }
    };
  }
}

/** Single-process publisher (tests, Redis-less dev). Still persists to the DB. */
export class LocalEventPublisher implements EventPublisher {
  private handlers = new Map<string, Set<(e: ForgeEvent) => void>>();
  constructor(private readonly db: Db | null) {}
  async publish(input: ForgeEventInput): Promise<ForgeEvent> {
    const e = complete(input);
    if (this.db) await persist(this.db, e);
    for (const h of this.handlers.get(e.projectId) ?? []) h(e);
    return e;
  }
  async subscribe(projectId: string, fn: (e: ForgeEvent) => void): Promise<() => void> {
    let set = this.handlers.get(projectId);
    if (!set) this.handlers.set(projectId, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }
}
