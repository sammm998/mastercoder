import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import type { JobQueue } from "../deps.js";

/** BullMQ producer. Consumers live in apps/agent-worker. */
export class BullJobQueue implements JobQueue {
  private queues = new Map<string, Queue>();
  constructor(private readonly connection: Redis) {}
  private q(name: string): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.connection, defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 5000, attempts: 1 } });
      this.queues.set(name, q);
    }
    return q;
  }
  async add(queue: string, name: string, payload: unknown, opts: { delayMs?: number; jobId?: string; repeatCron?: string } = {}) {
    const job = await this.q(queue).add(name, payload, {
      delay: opts.delayMs,
      jobId: opts.jobId,
      ...(opts.repeatCron ? { repeat: { pattern: opts.repeatCron } } : {}),
    });
    return { id: String(job.id) };
  }
  async close() {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}

/** Records jobs in memory (tests). */
export class MemoryJobQueue implements JobQueue {
  readonly jobs: Array<{ queue: string; name: string; payload: unknown; opts?: unknown }> = [];
  async add(queue: string, name: string, payload: unknown, opts?: unknown) {
    this.jobs.push({ queue, name, payload, opts });
    return { id: `job-${this.jobs.length}` };
  }
}
