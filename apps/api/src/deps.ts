import type { Db } from "@forge/db";
import type { LLMProvider } from "@forge/llm";
import type { ForgeEvent, ForgeEventInput, ObjectStore, Logger, UsageSink } from "@forge/shared";
import type { EmailProvider } from "./lib/email.js";
import type { RateLimiter } from "./lib/ratelimit.js";
import type { BotProtection } from "./auth/bot-protection.js";
import type { KeyValueStore } from "./lib/kv.js";

export interface JobQueue {
  add(queue: string, name: string, payload: unknown, opts?: { delayMs?: number; jobId?: string; repeatCron?: string }): Promise<{ id: string }>;
}

export interface EventPublisher {
  /** Persist and fan out an event for a project. */
  publish(e: ForgeEventInput): Promise<ForgeEvent>;
  subscribe(projectId: string, fn: (e: ForgeEvent) => void): Promise<() => void>;
}

export interface ApiConfig {
  appUrl: string;
  apiUrl: string;
  cookieSecure: boolean;
  sessionDays: number;
  rateLimitPerMinUser: number;
  rateLimitPerMinIp: number;
  oauth: {
    google?: { clientId: string; clientSecret: string };
    microsoft?: { clientId: string; clientSecret: string; tenant: string };
  };
}

/**
 * Optional domain services provided by wave-1 packages. The API works without them (features report
 * "not configured"), so the core can be tested in isolation.
 */
export interface DomainServices {
  [name: string]: unknown;
}

export interface ApiDeps {
  db: Db;
  email: EmailProvider;
  rateLimiter: RateLimiter;
  botProtection: BotProtection;
  store: ObjectStore;
  queue: JobQueue;
  events: EventPublisher;
  kv: KeyValueStore;
  llm: LLMProvider;
  usage: UsageSink;
  log: Logger;
  config: ApiConfig;
  services: DomainServices;
}
