import { connect, runMigrations } from "@forge/db";
import { MockLLMProvider } from "@forge/llm";
import { LocalObjectStore, MemoryUsageSink, createLogger, sumEstimate, type Intent } from "@forge/shared";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiDeps } from "../src/deps.js";
import { MockEmailProvider } from "../src/lib/email.js";
import { MemoryRateLimiter } from "../src/lib/ratelimit.js";
import { HeuristicBotProtection } from "../src/auth/bot-protection.js";
import { LocalEventPublisher } from "../src/lib/events.js";
import { MemoryJobQueue } from "../src/lib/queue.js";
import { MemoryKv } from "../src/lib/kv.js";
import { createCallerFactory, type Context, type SessionUser } from "../src/trpc.js";
import { appRouter } from "../src/router.js";
import { AuthService } from "../src/auth/service.js";

export async function testDeps(): Promise<ApiDeps & { email: MockEmailProvider; queue: MemoryJobQueue; close(): Promise<void> }> {
  await runMigrations();
  const h = connect(undefined, 5);
  const email = new MockEmailProvider();
  const queue = new MemoryJobQueue();
  const deps = {
    db: h.db,
    email,
    rateLimiter: new MemoryRateLimiter(),
    botProtection: new HeuristicBotProtection(),
    store: new LocalObjectStore(mkdtempSync(join(tmpdir(), "forge-api-"))),
    queue,
    events: new LocalEventPublisher(h.db),
    kv: new MemoryKv(),
    llm: new MockLLMProvider(),
    usage: new MemoryUsageSink(),
    log: createLogger({ test: true }, "error"),
    config: {
      appUrl: "http://app.test",
      apiUrl: "http://api.test",
      cookieSecure: false,
      sessionDays: 1,
      rateLimitPerMinUser: 1000,
      rateLimitPerMinIp: 1000,
      oauth: {},
    },
    services: {
      intent: {
        // Deterministic stand-in for @forge/intent-router in API tests.
        async classify(prompt: string) {
          const kind = /bild|image/i.test(prompt) ? "image" : "app";
          const intents: Intent[] = [{ kind, confidence: 0.9, summary: prompt.slice(0, 60) }];
          const ambiguous = /something/i.test(prompt);
          return { intents, needsClarification: ambiguous, question: ambiguous ? "What should it do?" : undefined, estimate: sumEstimate([{ label: "build", usd: 1 }]), language: "en" };
        },
      },
    },
    close: () => h.close(),
  };
  return deps;
}

export function ctxFor(deps: ApiDeps, user: SessionUser | null, ip = "127.0.0.1", token: string | null = null): Context {
  return { deps, user, sessionToken: token, ip, userAgent: "vitest", setCookie: () => undefined, clearCookie: () => undefined };
}

export const caller = createCallerFactory(appRouter);

export async function signup(deps: ApiDeps, email: string) {
  const c = caller(ctxFor(deps, null, `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`));
  const r = await c.auth.signup({ email, password: "Correct-Horse-9", name: email.split("@")[0] ?? "", locale: "en", elapsedMs: 5000 });
  const auth = new AuthService({ db: deps.db, email: deps.email, appUrl: deps.config.appUrl, sessionDays: 1 });
  const user = await auth.userFromToken(r.token);
  return { ...r, user: user!, c: caller(ctxFor(deps, user, "127.0.0.1", r.token)) };
}

export const uniq = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
