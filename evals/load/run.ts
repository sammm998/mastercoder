import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { QUEUES } from "@forge/shared";
import { ROOT, client, startStack, waitFor } from "../bench/stack.js";

/**
 * Load test (Definition of Done #9): N concurrent build tasks through the public API and BullMQ,
 * processed by W worker processes. Pass = every task reaches a terminal state and no worker job fails
 * with an infrastructure error (crash, stall, DB/Redis error).
 *
 *   pnpm load-test --tasks 50 --workers 3 --mix code|light
 *
 * "light" (default) uses media/slides tasks (no npm installs) so the test measures queueing, workers,
 * DB, Redis and events. "code" runs real scaffold + gate builds (needs much more CPU and time).
 */
const args = process.argv.slice(2);
const arg = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? (args[i + 1] ?? d) : d;
};
const N = Number(arg("tasks", "50"));
const W = Number(arg("workers", "3"));
const mix = arg("mix", "light");
const outDir = resolve(ROOT, "evals/results", `load-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(outDir, { recursive: true });

const LIGHT = [
  "Generate a set of 4 product images for a minimalist Scandinavian coffee brand in a consistent style.",
  "Create a 10-slide pitch deck for a startup that sells AI bookkeeping to small businesses.",
  "Write a market analysis report on the Nordic e-bike market as a document I can download.",
  "Generate a 6-second video of waves on a rocky Swedish coast.",
];
const CODE = [
  "Create a dashboard where I upload a CSV of sales and see revenue per month and top products as charts.",
  "Create a FastAPI service with CRUD endpoints for inventory items, input validation and OpenAPI docs.",
  "Bygg en att-göra-app där jag kan lägga till och bocka av uppgifter.",
];
const prompts = mix === "code" ? CODE : LIGHT;

const stack = await startStack({ workers: W, log: (s) => appendFileSync(resolve(outDir, "stack.log"), s + "\n") });
const su = await client(stack.apiUrl).auth.signup.mutate({ email: `load-${Date.now()}@bench.forge.test`, password: "Load-Password-2026", name: "Load", locale: "en", elapsedMs: 5000 });
const c = client(stack.apiUrl, su.token);

const t0 = Date.now();
const created = await Promise.all(
  Array.from({ length: N }, async (_, i) => {
    const { id: projectId } = await c.project.create.mutate({ workspaceId: su.workspaceId, name: `load-${i}` });
    const t = await c.task.create.mutate({ projectId, prompt: prompts[i % prompts.length]!, source: "typed", planMode: false });
    return { i, taskId: t.id };
  }),
);
console.log(`enqueued ${created.length} tasks in ${Date.now() - t0}ms`);

const final = await waitFor(
  async () => {
    const rows = await Promise.all(created.map((x) => c.task.get.query({ taskId: x.taskId })));
    const pending = rows.filter((r) => ["queued", "running"].includes(r.status)).length;
    process.stdout.write(`\r${N - pending}/${N} done`);
    return pending === 0 ? rows : null;
  },
  Number(arg("timeout", String(60 * 60))) * 1000,
  3000,
);
const elapsed = Date.now() - t0;

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", { maxRetriesPerRequest: null });
const failedJobs: Array<{ queue: string; reason: string }> = [];
for (const q of [QUEUES.build, QUEUES.media, QUEUES.slides]) {
  const queue = new Queue(q, { connection: redis });
  for (const j of await queue.getFailed(0, 1000)) if (created.some((x) => (j.data as { taskId?: string }).taskId === x.taskId)) failedJobs.push({ queue: q, reason: j.failedReason });
  await queue.close();
}
await redis.quit();
await stack.stop();

const byStatus = final.reduce<Record<string, number>>((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {});
const ok = failedJobs.length === 0 && final.every((r) => ["succeeded", "failed", "cancelled", "awaiting_approval"].includes(r.status));
const md = `# Load test — ${new Date().toISOString()}\n\n**${ok ? "PASS" : "FAIL"}**: ${N} concurrent tasks (${mix}), ${W} worker process(es), ${Math.round(elapsed / 1000)}s.\n\nStatuses: ${JSON.stringify(byStatus)}\n\nWorker job failures: ${failedJobs.length}\n${failedJobs.map((f) => `- ${f.queue}: ${f.reason}`).join("\n")}\n`;
writeFileSync(resolve(outDir, "report.md"), md);
writeFileSync(resolve(ROOT, "evals/results/load-latest.md"), md);
console.log(`\n${md}`);
process.exit(ok ? 0 : 1);
