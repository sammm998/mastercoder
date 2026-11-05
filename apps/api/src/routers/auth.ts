import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, authedProcedure, audit, type Context } from "../trpc.js";
import { AuthService, SESSION_COOKIE } from "../auth/service.js";

const Locale = z.enum(["en", "sv"]).default("en");

export function authService(ctx: Context): AuthService {
  return new AuthService({ db: ctx.deps.db, email: ctx.deps.email, appUrl: ctx.deps.config.appUrl, sessionDays: ctx.deps.config.sessionDays });
}

function setSession(ctx: Context, token: string) {
  ctx.setCookie(SESSION_COOKIE, token, ctx.deps.config.sessionDays * 86400);
}

/** Separate, stricter limit for credential endpoints (brute force / signup abuse). */
async function credentialLimit(ctx: Context, bucket: string) {
  const r = await ctx.deps.rateLimiter.hit(`auth:${bucket}:${ctx.ip}`, 10, 60);
  if (!r.allowed) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `Too many attempts; retry in ${r.resetSec}s` });
}

export const authRouter = router({
  me: publicProcedure.query(({ ctx }) => ctx.user),

  signup: publicProcedure
    .input(
      z.object({
        email: z.string().email().max(254),
        password: z.string().min(1).max(200),
        name: z.string().max(100).default(""),
        locale: Locale,
        captchaToken: z.string().optional(),
        website: z.string().optional(),
        elapsedMs: z.number().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await credentialLimit(ctx, "signup");
      const bot = await ctx.deps.botProtection.verify({ token: input.captchaToken, ip: ctx.ip, website: input.website, elapsedMs: input.elapsedMs });
      if (!bot.ok) throw new TRPCError({ code: "FORBIDDEN", message: `Bot check failed: ${bot.reason}` });
      const r = await authService(ctx).signup(input);
      setSession(ctx, r.token);
      await audit({ ...ctx, user: r.user }, "auth.signup", { workspaceId: r.workspaceId, target: r.user.id });
      return { user: r.user, workspaceId: r.workspaceId, token: r.token };
    }),

  login: publicProcedure.input(z.object({ email: z.string().email(), password: z.string().max(200) })).mutation(async ({ ctx, input }) => {
    await credentialLimit(ctx, "login");
    const r = await authService(ctx).login(input.email, input.password);
    setSession(ctx, r.token);
    await audit({ ...ctx, user: r.user }, "auth.login", { target: r.user.id });
    return { user: r.user, token: r.token };
  }),

  requestMagicLink: publicProcedure.input(z.object({ email: z.string().email(), locale: Locale })).mutation(async ({ ctx, input }) => {
    await credentialLimit(ctx, "magic");
    await authService(ctx).requestMagicLink(input.email, input.locale);
    return { sent: true };
  }),

  verifyMagicLink: publicProcedure.input(z.object({ token: z.string().min(10).max(200), locale: Locale })).mutation(async ({ ctx, input }) => {
    await credentialLimit(ctx, "magic-verify");
    const r = await authService(ctx).verifyMagicLink(input.token, input.locale);
    setSession(ctx, r.token);
    await audit({ ...ctx, user: r.user }, "auth.magic_link", { target: r.user.id });
    return { user: r.user, token: r.token };
  }),

  logout: authedProcedure.mutation(async ({ ctx }) => {
    if (ctx.sessionToken) await authService(ctx).revokeSession(ctx.sessionToken);
    ctx.clearCookie(SESSION_COOKIE);
    return { ok: true };
  }),
});
