import type { Redis } from "ioredis";

/** Small TTL key-value store (OAuth state, upload sessions, presence). */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
  del(key: string): Promise<void>;
}

export class RedisKv implements KeyValueStore {
  constructor(private readonly redis: Redis) {}
  async get(key: string) {
    return this.redis.get(key);
  }
  async set(key: string, value: string, ttlSec: number) {
    await this.redis.set(key, value, "EX", ttlSec);
  }
  async del(key: string) {
    await this.redis.del(key);
  }
}

export class MemoryKv implements KeyValueStore {
  private m = new Map<string, { v: string; exp: number }>();
  async get(key: string) {
    const e = this.m.get(key);
    if (!e) return null;
    if (e.exp < Date.now()) {
      this.m.delete(key);
      return null;
    }
    return e.v;
  }
  async set(key: string, value: string, ttlSec: number) {
    this.m.set(key, { v: value, exp: Date.now() + ttlSec * 1000 });
  }
  async del(key: string) {
    this.m.delete(key);
  }
}
