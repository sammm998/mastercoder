import { describe, it, expect, afterAll } from "vitest";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { connect, runMigrations, eq, users, workspaces, userAgents } from "@forge/db";
import { newId } from "@forge/shared";
import { syncAgentSchedules, schedulerId } from "../src/scheduler.js";

const h = connect(undefined, 2);
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", { maxRetriesPerRequest: null });
const queue = new Queue(`test-agent-run-${Date.now()}`, { connection: redis });
afterAll(async () => {
  await queue.obliterate({ force: true });
  await queue.close();
  await redis.quit();
  await h.close();
});

describe("cron scheduler", () => {
  it("creates, updates and removes job schedulers for agent cron triggers", async () => {
    await runMigrations();
    const ws = newId("ws");
    const id = newId("agt");
    await h.db.insert(users).values({ id: newId("usr"), email: `${ws}@t.local` });
    await h.db.insert(workspaces).values({ id: ws, name: "w" });
    await h.db.insert(userAgents).values({ id, workspaceId: ws, name: "weekly", definition: { triggers: [{ type: "cron", cron: "0 8 * * 1", timezone: "Europe/Stockholm" }, { type: "webhook" }] } });
    const r1 = await syncAgentSchedules(h.db, queue);
    expect(r1.upserted).toContain(schedulerId(id, 0));
    const s = await queue.getJobScheduler(schedulerId(id, 0));
    expect(s?.pattern).toBe("0 8 * * 1");
    expect(s?.tz).toBe("Europe/Stockholm");
    expect((await syncAgentSchedules(h.db, queue)).upserted).not.toContain(schedulerId(id, 0));
    await h.db.update(userAgents).set({ status: "paused" }).where(eq(userAgents.id, id));
    expect((await syncAgentSchedules(h.db, queue)).removed).toContain(schedulerId(id, 0));
    expect((await queue.getJobSchedulers(0, -1)).map((x) => x.key)).not.toContain(schedulerId(id, 0));
  });
});
