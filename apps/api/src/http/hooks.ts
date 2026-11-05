import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { and, eq, userAgents, agentRuns } from "@forge/db";
import { QUEUES } from "@forge/shared";
import type { ApiDeps } from "../deps.js";
import { AuthService, SESSION_COOKIE } from "../auth/service.js";
import { requireService, type UploadService } from "../services.js";

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Non-tRPC HTTP endpoints: resumable chunk uploads, agent triggers (webhook, inbound email, REST chat).
 */
export function registerHooks(app: FastifyInstance, deps: ApiDeps) {
  const auth = new AuthService({ db: deps.db, email: deps.email, appUrl: deps.config.appUrl, sessionDays: deps.config.sessionDays });
  const userOf = (req: FastifyRequest) => {
    const h = req.headers.authorization;
    return auth.userFromToken((req.cookies[SESSION_COOKIE] as string | undefined) ?? (h?.startsWith("Bearer ") ? h.slice(7) : null));
  };

  // Keep the raw JSON body so webhook signatures are verified over the exact bytes received.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as FastifyRequest & { rawBody?: string }).rawBody = String(body);
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(String(body)));
    } catch (e) {
      (e as Error & { statusCode?: number }).statusCode = 400;
      done(e as Error, undefined);
    }
  });
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: 17 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  /** PUT /uploads/:uploadId/:index — idempotent; header x-chunk-sha256 is verified by the upload service. */
  app.put("/uploads/:uploadId/:index", async (req, reply) => {
    const user = await userOf(req);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    const { uploadId, index } = req.params as { uploadId: string; index: string };
    const raw = await deps.kv.get(`upload:${uploadId}`);
    if (!raw) return reply.code(404).send({ error: "upload not found" });
    const meta = JSON.parse(raw) as { userId: string };
    if (meta.userId !== user.id) return reply.code(403).send({ error: "forbidden" });
    const sha = String(req.headers["x-chunk-sha256"] ?? "");
    const idx = Number(index);
    if (!Number.isInteger(idx) || idx < 0 || !/^[a-f0-9]{64}$/.test(sha)) return reply.code(400).send({ error: "bad chunk" });
    try {
      const r = await requireService<UploadService>(deps.services, "uploads").putChunk(uploadId, idx, new Uint8Array(req.body as Buffer), sha);
      return { ok: true, received: r.received.length };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /** Webhook trigger. Signature: hex HMAC-SHA256(body, agent.webhookSecret) in x-forge-signature. */
  app.post("/hooks/agents/:agentId", async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const [agent] = await deps.db.select().from(userAgents).where(eq(userAgents.id, agentId));
    if (!agent || !agent.webhookSecret) return reply.code(404).send({ error: "not found" });
    const body = (req as FastifyRequest & { rawBody?: string }).rawBody ?? "";
    const expected = createHmac("sha256", agent.webhookSecret).update(body).digest("hex");
    if (!safeEqual(String(req.headers["x-forge-signature"] ?? ""), expected)) return reply.code(401).send({ error: "bad signature" });
    if (agent.status !== "active") return reply.code(409).send({ error: "agent paused" });
    const rl = await deps.rateLimiter.hit(`agent-hook:${agentId}`, 60, 60);
    if (!rl.allowed) return reply.code(429).send({ error: "rate limited" });
    const job = await deps.queue.add(QUEUES.agentRun, "run", { agentId, workspaceId: agent.workspaceId, trigger: "webhook", input: req.body });
    return { accepted: true, jobId: job.id };
  });

  /** Inbound email (provider-agnostic JSON: Postmark/SendGrid/Mailgun inbound normalised by the relay). */
  const InboundEmail = z.object({ to: z.string(), from: z.string(), subject: z.string().default(""), text: z.string().default(""), secret: z.string() });
  app.post("/hooks/email", async (req, reply) => {
    const p = InboundEmail.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: "bad payload" });
    if (!process.env.INBOUND_EMAIL_SECRET || !safeEqual(p.data.secret, process.env.INBOUND_EMAIL_SECRET)) return reply.code(401).send({ error: "unauthorized" });
    const m = p.data.to.match(/agent\+([a-z0-9_]+)@/i);
    if (!m?.[1]) return reply.code(404).send({ error: "no agent address" });
    const [agent] = await deps.db.select().from(userAgents).where(eq(userAgents.id, m[1]));
    if (!agent || agent.status !== "active") return reply.code(404).send({ error: "agent not found" });
    const job = await deps.queue.add(QUEUES.agentRun, "run", { agentId: agent.id, workspaceId: agent.workspaceId, trigger: "email", input: { from: p.data.from, subject: p.data.subject, text: p.data.text } });
    return { accepted: true, jobId: job.id };
  });

  /** REST channel: POST /v1/agents/:id/messages (Bearer = webhook secret) → run id; poll GET .../runs/:runId. */
  const agentFromBearer = async (req: FastifyRequest) => {
    const { agentId } = req.params as { agentId: string };
    const [agent] = await deps.db.select().from(userAgents).where(eq(userAgents.id, agentId));
    const h = String(req.headers.authorization ?? "");
    if (!agent?.webhookSecret || !h.startsWith("Bearer ") || !safeEqual(h.slice(7), agent.webhookSecret)) return null;
    return agent;
  };
  app.post("/v1/agents/:agentId/messages", async (req, reply) => {
    const agent = await agentFromBearer(req);
    if (!agent) return reply.code(401).send({ error: "unauthorized" });
    const p = z.object({ message: z.string().min(1).max(20000), conversationId: z.string().max(100).optional() }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: "message required" });
    const job = await deps.queue.add(QUEUES.agentRun, "run", { agentId: agent.id, workspaceId: agent.workspaceId, trigger: "chat", input: p.data });
    return { accepted: true, jobId: job.id };
  });
  app.get("/v1/agents/:agentId/runs/:runId", async (req, reply) => {
    const agent = await agentFromBearer(req);
    if (!agent) return reply.code(401).send({ error: "unauthorized" });
    const { runId } = req.params as { runId: string };
    const [run] = await deps.db.select().from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.agentId, agent.id)));
    if (!run) return reply.code(404).send({ error: "not found" });
    return { id: run.id, status: run.status, costUsd: run.costUsd, log: run.log };
  });
}
