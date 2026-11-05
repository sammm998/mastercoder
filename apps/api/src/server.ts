import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from "@trpc/server/adapters/fastify";
import { z } from "zod";
import { appRouter, type AppRouter } from "./router.js";
import type { ApiDeps } from "./deps.js";
import type { Context } from "./trpc.js";
import { AuthService, SESSION_COOKIE } from "./auth/service.js";
import { OAuthService, type OAuthProviderId } from "./auth/oauth.js";
import { CollabServer, type CollabRelay } from "./ws/collab.js";
import { registerGateway, type AudioStreamHandler } from "./ws/gateway.js";
import { registerHooks } from "./http/hooks.js";

export interface HttpExtension {
  register(app: FastifyInstance, deps: ApiDeps): void | Promise<void>;
}

export interface BuildServerOptions {
  collabRelay?: CollabRelay | null;
  audio?: AudioStreamHandler;
  extensions?: HttpExtension[];
  logger?: boolean;
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7) : null;
}

export async function buildServer(deps: ApiDeps, opts: BuildServerOptions = {}): Promise<{ app: FastifyInstance; collab: CollabServer }> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 25 * 1024 * 1024, trustProxy: true, maxParamLength: 5000 });
  await app.register(cookie);
  await app.register(cors, {
    origin: [deps.config.appUrl, process.env.ADMIN_URL || "http://localhost:3001", ...(process.env.CORS_ORIGINS ?? "").split(",").filter(Boolean), /^exp:\/\//, /^http:\/\/localhost:\d+$/],
    credentials: true,
  });
  await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });

  const auth = new AuthService({ db: deps.db, email: deps.email, appUrl: deps.config.appUrl, sessionDays: deps.config.sessionDays });
  // COOKIE_SAME_SITE=none is needed when web and api are on different sites (e.g. two *.up.railway.app
  // domains, a public suffix); it requires HTTPS. Default lax for same-site deployments.
  const sameSite = process.env.COOKIE_SAME_SITE === "none" ? ("none" as const) : ("lax" as const);
  const cookieOpts = { path: "/", httpOnly: true, sameSite, secure: sameSite === "none" ? true : deps.config.cookieSecure };

  const createContext = async ({ req, res }: { req: FastifyRequest; res: FastifyReply }): Promise<Context> => {
    const token = (req.cookies[SESSION_COOKIE] as string | undefined) ?? bearer(req);
    const user = await auth.userFromToken(token);
    return {
      deps,
      user,
      sessionToken: token ?? null,
      ip: req.ip,
      userAgent: String(req.headers["user-agent"] ?? ""),
      setCookie: (name, value, maxAge) => void res.setCookie(name, value, { ...cookieOpts, maxAge }),
      clearCookie: (name) => void res.clearCookie(name, { path: "/" }),
    };
  };

  await app.register(fastifyTRPCPlugin, {
    prefix: "/trpc",
    trpcOptions: {
      router: appRouter,
      createContext,
      onError: ({ path, error }) => {
        if (error.code === "INTERNAL_SERVER_ERROR") deps.log.error("trpc error", { path, error: error.message });
      },
    } satisfies FastifyTRPCPluginOptions<AppRouter>["trpcOptions"],
  });

  app.get("/health", async () => ({ ok: true, region: process.env.DATA_REGION || "eu-central-1" }));

  // OAuth sign-in (Google / Microsoft) — browser redirects, so plain HTTP routes rather than tRPC.
  const oauth = new OAuthService(deps.config, deps.kv);
  const Provider = z.enum(["google", "microsoft"]);
  app.get("/auth/oauth/:provider/start", async (req, reply) => {
    const provider = Provider.safeParse((req.params as { provider: string }).provider);
    if (!provider.success) return reply.code(404).send({ error: "unknown provider" });
    const returnTo = String((req.query as Record<string, string>).returnTo ?? "/");
    const safeReturn = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
    try {
      return reply.redirect(await oauth.start(provider.data as OAuthProviderId, safeReturn));
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  app.get("/auth/oauth/:provider/callback", async (req, reply) => {
    const provider = Provider.safeParse((req.params as { provider: string }).provider);
    const q = req.query as Record<string, string | undefined>;
    if (!provider.success || !q.code || !q.state) return reply.code(400).send({ error: "bad callback" });
    try {
      const profile = await oauth.callback(provider.data as OAuthProviderId, q.code, q.state);
      const r = await auth.loginOrCreateVerified(profile.email, profile.name, "en");
      reply.setCookie(SESSION_COOKIE, r.token, { ...cookieOpts, maxAge: deps.config.sessionDays * 86400 });
      return reply.redirect(`${deps.config.appUrl}${profile.returnTo}`);
    } catch (e) {
      return reply.redirect(`${deps.config.appUrl}/login?error=${encodeURIComponent((e as Error).message)}`);
    }
  });

  const collab = new CollabServer(deps.db, deps.log, opts.collabRelay ?? null);
  deps.services.collab = collab;
  registerGateway(app, deps, collab, opts.audio);
  registerHooks(app, deps);
  for (const ext of opts.extensions ?? []) await ext.register(app, deps);

  app.addHook("onClose", async () => {
    await collab.flushAll();
  });
  return { app, collab };
}
