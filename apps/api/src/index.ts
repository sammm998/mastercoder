import { Redis } from "ioredis";
import { connect, runMigrations, DbObjectStore } from "@forge/db";
import { createLLM } from "@forge/llm";
import { createLogger, createObjectStore, MemoryUsageSink } from "@forge/shared";
import { buildServer } from "./server.js";
import { loadConfig } from "./config.js";
import { createEmailProvider } from "./lib/email.js";
import { RedisRateLimiter } from "./lib/ratelimit.js";
import { createBotProtection } from "./auth/bot-protection.js";
import { RedisEventPublisher } from "./lib/events.js";
import { BullJobQueue } from "./lib/queue.js";
import { RedisKv } from "./lib/kv.js";
import { RedisCollabRelay } from "./ws/relay.js";
import { wireServices } from "./wiring.js";
import type { ApiDeps } from "./deps.js";

const log = createLogger({ service: "api" });
const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";


/** STORAGE_PROVIDER=db keeps objects in Postgres (shared by api + worker); otherwise local / s3. */
async function objectStore(db: Parameters<typeof dbStore>[0]) {
  if ((process.env.STORAGE_PROVIDER || "").toLowerCase() === "db") return dbStore(db);
  return createObjectStore();
}
function dbStore(db: ConstructorParameters<typeof DbObjectStore>[0]) {
  return new DbObjectStore(db, { publicBaseUrl: process.env.API_URL || "http://localhost:4000", secret: process.env.FILES_SECRET || process.env.AUTH_SECRET || "dev-secret" });
}

await runMigrations();
const { db } = connect();
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const sub = new Redis(redisUrl, { maxRetriesPerRequest: null });
const collabSub = new Redis(redisUrl, { maxRetriesPerRequest: null });

const deps: ApiDeps = {
  db,
  email: createEmailProvider(),
  rateLimiter: new RedisRateLimiter(redis),
  botProtection: createBotProtection(),
  store: await objectStore(db),
  queue: new BullJobQueue(redis),
  events: new RedisEventPublisher(db, redis, sub),
  kv: new RedisKv(redis),
  llm: createLLM(),
  usage: new MemoryUsageSink(),
  log,
  config: loadConfig(),
  services: {},
};
const wired = await wireServices(deps);

const { app } = await buildServer(deps, { collabRelay: new RedisCollabRelay(redis, collabSub), audio: wired.audio, extensions: wired.extensions });
const port = Number(process.env.PORT || process.env.API_PORT || 4000);
await app.listen({ port, host: "0.0.0.0" });
log.info("api listening", { port, llm: deps.llm.name, mockLLM: deps.llm.isMock });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.close();
    process.exit(0);
  });
}
