import type { Job } from "bullmq";
import type { Db } from "@forge/db";
import type { LLMProvider } from "@forge/llm";
import { QUEUES, type EventSink, type Logger, type ObjectStore } from "@forge/shared";
import type { DbUsageSink } from "./runtime.js";

export interface BuildQueueDeps {
  consume(queue: string, handler: (job: Job) => Promise<unknown>, concurrency?: number): void;
  db: Db;
  llm: LLMProvider;
  store: ObjectStore;
  events: EventSink;
  usage: DbUsageSink;
  log: Logger;
}

/**
 * Registers the build and deploy queues. They need @forge/templates and @forge/app-kit; until those
 * are installed the queues fail jobs with an explicit "not available" error instead of hanging.
 */
export async function registerBuildQueue(d: BuildQueueDeps): Promise<void> {
  let wire: ((d: BuildQueueDeps) => Promise<void>) | null = null;
  try {
    const modulePath = "./build-wiring.js";
    const mod = (await import(/* @vite-ignore */ modulePath)) as { wireBuild: (d: BuildQueueDeps) => Promise<void> };
    wire = mod.wireBuild;
  } catch (e) {
    d.log.warn("build pipeline unavailable", { error: (e as Error).message });
  }
  if (wire) return wire(d);
  const unavailable = async () => {
    throw new Error("Build pipeline is not available on this worker (templates/app-kit not installed)");
  };
  d.consume(QUEUES.build, unavailable, 1);
  d.consume(QUEUES.deploy, unavailable, 1);
}
