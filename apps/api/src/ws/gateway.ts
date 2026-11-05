import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import type { ApiDeps } from "../deps.js";
import type { Context } from "../trpc.js";
import { requireProject } from "../trpc.js";
import { AuthService, SESSION_COOKIE } from "../auth/service.js";
import type { CollabServer } from "./collab.js";

/** Optional handler for streaming voice prompts (wired to @forge/speech). */
export interface AudioStreamHandler {
  handle(ws: WebSocket, opts: { userId: string; projectId: string; language: string }): void;
}

async function wsContext(deps: ApiDeps, req: FastifyRequest): Promise<Context> {
  const q = req.query as Record<string, string | undefined>;
  const auth0 = String(req.headers.authorization ?? "");
  const token = (req.cookies as Record<string, string | undefined>)[SESSION_COOKIE] ?? (auth0.startsWith("Bearer ") ? auth0.slice(7) : undefined) ?? q.token ?? null;
  const auth = new AuthService({ db: deps.db, email: deps.email, appUrl: deps.config.appUrl, sessionDays: deps.config.sessionDays });
  const user = await auth.userFromToken(token);
  return { deps, user, sessionToken: token, ip: req.ip, userAgent: String(req.headers["user-agent"] ?? ""), setCookie: () => undefined, clearCookie: () => undefined };
}

const ClientMsg = z.discriminatedUnion("type", [
  z.object({ type: z.literal("presence"), name: z.string().max(80), cursor: z.unknown().optional() }),
  z.object({ type: z.literal("ping") }),
]);

export function registerGateway(app: FastifyInstance, deps: ApiDeps, collab: CollabServer, audio?: AudioStreamHandler) {
  /** Live agent/media/meeting event stream for a project. */
  app.get("/ws/events/:projectId", { websocket: true }, async (socket: WebSocket, req: FastifyRequest) => {
    const { projectId } = req.params as { projectId: string };
    try {
      const ctx = await wsContext(deps, req);
      await requireProject(ctx, projectId, "project.read");
      const unsub = await deps.events.subscribe(projectId, (e) => {
        if (socket.readyState === 1) socket.send(JSON.stringify(e));
      });
      socket.on("message", async (raw: Buffer) => {
        let parsed;
        try {
          parsed = ClientMsg.safeParse(JSON.parse(raw.toString()));
        } catch {
          return;
        }
        if (!parsed.success) return;
        if (parsed.data.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
        else if (ctx.user) await deps.events.publish({ type: "presence", projectId, userId: ctx.user.id, name: parsed.data.name, cursor: parsed.data.cursor });
      });
      socket.on("close", unsub);
      socket.send(JSON.stringify({ type: "ready", projectId }));
    } catch (e) {
      socket.close(4403, (e as Error).message.slice(0, 100));
    }
  });

  /** Yjs collaboration: /ws/collab/:projectId?doc=<file path> */
  app.get("/ws/collab/:projectId", { websocket: true }, async (socket: WebSocket, req: FastifyRequest) => {
    const { projectId } = req.params as { projectId: string };
    const doc = String((req.query as Record<string, string>).doc ?? "");
    if (!doc || doc.includes("..") || doc.length > 400) return socket.close(4400, "bad doc");
    // The client sends sync step 1 immediately; buffer messages until auth + room load complete.
    const pending: Buffer[] = [];
    const buffer = (m: Buffer) => pending.push(m);
    socket.on("message", buffer);
    try {
      const ctx = await wsContext(deps, req);
      await requireProject(ctx, projectId, "project.write");
      await collab.handle(socket, `${projectId}:${doc}`, projectId);
      socket.off("message", buffer);
      for (const m of pending) socket.emit("message", m, true);
    } catch (e) {
      socket.close(4403, (e as Error).message.slice(0, 100));
    }
  });

  /** Streaming speech-to-text for the mic button. */
  app.get("/ws/audio/:projectId", { websocket: true }, async (socket: WebSocket, req: FastifyRequest) => {
    const { projectId } = req.params as { projectId: string };
    const language = String((req.query as Record<string, string>).lang ?? "sv");
    const pending: Array<[Buffer, boolean]> = [];
    const buffer = (m: Buffer, isBinary: boolean) => pending.push([m, isBinary]);
    socket.on("message", buffer);
    try {
      const ctx = await wsContext(deps, req);
      const { project } = await requireProject(ctx, projectId, "project.write");
      if (!audio || !ctx.user) return socket.close(4501, "speech not configured");
      audio.handle(socket, { userId: ctx.user.id, projectId: project.id, language });
      socket.off("message", buffer);
      for (const [m, isBinary] of pending) socket.emit("message", m, isBinary);
    } catch (e) {
      socket.close(4403, (e as Error).message.slice(0, 100));
    }
  });
}
