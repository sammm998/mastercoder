import type { Queue } from "bullmq";
import { eq, userAgents, type Db } from "@forge/db";
import { QUEUES, type AgentRunJob } from "@forge/shared";

interface CronTrigger {
  type: "cron";
  cron: string;
  timezone?: string;
}

export function schedulerId(agentId: string, idx: number): string {
  return `agent:${agentId}:cron:${idx}`;
}

/**
 * Keeps BullMQ job schedulers in sync with active agents' cron triggers. Paused or deleted agents lose
 * their schedulers. Runs on worker start and periodically (agents can change via the API at any time).
 */
export async function syncAgentSchedules(db: Db, queue: Queue): Promise<{ upserted: string[]; removed: string[] }> {
  const agents = await db.select().from(userAgents);
  const wanted = new Map<string, { pattern: string; tz: string; data: AgentRunJob }>();
  for (const a of agents) {
    if (a.status !== "active") continue;
    const triggers = ((a.definition as { triggers?: unknown[] }).triggers ?? []) as Array<CronTrigger | { type: string }>;
    triggers.forEach((t, i) => {
      if (t.type !== "cron") return;
      const c = t as CronTrigger;
      wanted.set(schedulerId(a.id, i), { pattern: c.cron, tz: c.timezone ?? "Europe/Stockholm", data: { agentId: a.id, workspaceId: a.workspaceId, trigger: "cron" } });
    });
  }
  const existing = await queue.getJobSchedulers(0, -1);
  const removed: string[] = [];
  for (const s of existing) {
    const id = s.key;
    if (id.startsWith("agent:") && !wanted.has(id)) {
      await queue.removeJobScheduler(id);
      removed.push(id);
    }
  }
  const upserted: string[] = [];
  for (const [id, w] of wanted) {
    const cur = existing.find((s) => s.key === id);
    if (cur && cur.pattern === w.pattern && cur.tz === w.tz) continue;
    await queue.upsertJobScheduler(id, { pattern: w.pattern, tz: w.tz }, { name: "run", data: w.data });
    upserted.push(id);
  }
  return { upserted, removed };
}

export async function agentIsActive(db: Db, agentId: string): Promise<boolean> {
  const [a] = await db.select({ status: userAgents.status }).from(userAgents).where(eq(userAgents.id, agentId));
  return a?.status === "active";
}

export const AGENT_QUEUE = QUEUES.agentRun;
