import type { Redis } from "ioredis";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetSec: number;
}

export interface RateLimiter {
  hit(key: string, limit: number, windowSec: number): Promise<RateLimitResult>;
}

/** Fixed-window counter in Redis, shared across API replicas. */
export class RedisRateLimiter implements RateLimiter {
  constructor(private readonly redis: Redis) {}
  async hit(key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
    const nowSec = Math.floor(Date.now() / 1000);
    const k = `rl:${key}:${Math.floor(nowSec / windowSec)}`;
    const n = await this.redis.incr(k);
    if (n === 1) await this.redis.expire(k, windowSec + 1);
    return { allowed: n <= limit, remaining: Math.max(0, limit - n), resetSec: windowSec - (nowSec % windowSec) };
  }
}

/** Single-process limiter for tests and Redis-less dev. */
export class MemoryRateLimiter implements RateLimiter {
  private counts = new Map<string, number>();
  async hit(key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
    const nowSec = Math.floor(Date.now() / 1000);
    const k = `${key}:${Math.floor(nowSec / windowSec)}`;
    const n = (this.counts.get(k) ?? 0) + 1;
    this.counts.set(k, n);
    return { allowed: n <= limit, remaining: Math.max(0, limit - n), resetSec: windowSec - (nowSec % windowSec) };
  }
}
