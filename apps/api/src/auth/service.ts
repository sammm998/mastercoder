import { and, eq, gte, isNull, users, authSessions, magicLinks, workspaces, memberships, type Db } from "@forge/db";
import { ForgeError, newId } from "@forge/shared";
import type { EmailProvider } from "../lib/email.js";
import { hashPassword, newToken, passwordProblems, sha256, verifyPassword } from "./password.js";
import type { SessionUser } from "../trpc.js";

export const SESSION_COOKIE = "forge_session";

export interface AuthServiceOpts {
  db: Db;
  email: EmailProvider;
  appUrl: string;
  sessionDays: number;
}

function normEmail(e: string): string {
  return e.trim().toLowerCase();
}

export class AuthService {
  constructor(private readonly o: AuthServiceOpts) {}

  private toSessionUser(u: typeof users.$inferSelect): SessionUser {
    return { id: u.id, email: u.email, name: u.name, locale: u.locale, isAdmin: u.isAdmin };
  }

  async createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = newToken();
    const expiresAt = new Date(Date.now() + this.o.sessionDays * 86400_000);
    await this.o.db.insert(authSessions).values({ id: newId("ses"), userId, tokenHash: sha256(token), expiresAt });
    return { token, expiresAt };
  }

  async userFromToken(token: string | null | undefined): Promise<SessionUser | null> {
    if (!token) return null;
    const rows = await this.o.db
      .select({ u: users })
      .from(authSessions)
      .innerJoin(users, eq(users.id, authSessions.userId))
      .where(and(eq(authSessions.tokenHash, sha256(token)), gte(authSessions.expiresAt, new Date()), isNull(users.deletedAt)));
    const row = rows[0];
    return row ? this.toSessionUser(row.u) : null;
  }

  async revokeSession(token: string): Promise<void> {
    await this.o.db.delete(authSessions).where(eq(authSessions.tokenHash, sha256(token)));
  }

  /** Creates the user plus a personal workspace where they are owner. */
  private async createUser(input: { email: string; name: string; locale: string; passwordHash?: string; verified: boolean }) {
    const id = newId("usr");
    const wsId = newId("ws");
    await this.o.db.transaction(async (tx) => {
      await tx.insert(users).values({ id, email: input.email, name: input.name, locale: input.locale, passwordHash: input.passwordHash, emailVerified: input.verified });
      await tx.insert(workspaces).values({ id: wsId, name: input.name ? `${input.name}'s workspace` : "My workspace" });
      await tx.insert(memberships).values({ workspaceId: wsId, userId: id, role: "owner" });
    });
    const [u] = await this.o.db.select().from(users).where(eq(users.id, id));
    if (!u) throw new ForgeError("INTERNAL", "User creation failed");
    return { user: u, workspaceId: wsId };
  }

  async signup(input: { email: string; password: string; name: string; locale: string }) {
    const email = normEmail(input.email);
    const problem = passwordProblems(input.password);
    if (problem) throw new ForgeError("BAD_INPUT", problem);
    const [existing] = await this.o.db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing) throw new ForgeError("BAD_INPUT", "An account with this email already exists");
    const { user, workspaceId } = await this.createUser({ email, name: input.name, locale: input.locale, passwordHash: await hashPassword(input.password), verified: false });
    const session = await this.createSession(user.id);
    return { user: this.toSessionUser(user), workspaceId, ...session };
  }

  async login(emailRaw: string, password: string) {
    const email = normEmail(emailRaw);
    const [u] = await this.o.db.select().from(users).where(and(eq(users.email, email), isNull(users.deletedAt)));
    // Constant-ish work even when the user doesn't exist, to blunt account enumeration via timing.
    const ok = u?.passwordHash ? await verifyPassword(password, u.passwordHash) : (await hashPassword(password), false);
    if (!u || !ok) throw new ForgeError("UNAUTHORIZED", "Invalid email or password");
    const session = await this.createSession(u.id);
    return { user: this.toSessionUser(u), ...session };
  }

  async requestMagicLink(emailRaw: string, locale: string): Promise<void> {
    const email = normEmail(emailRaw);
    const token = newToken();
    await this.o.db.insert(magicLinks).values({ id: newId("mgl"), email, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 15 * 60_000) });
    const link = `${this.o.appUrl}/auth/magic?token=${encodeURIComponent(token)}`;
    const sv = locale === "sv";
    await this.o.email.send({
      to: email,
      subject: sv ? "Din inloggningslänk till Forge" : "Your Forge sign-in link",
      text: sv ? `Logga in på Forge: ${link}\n\nLänken gäller i 15 minuter.` : `Sign in to Forge: ${link}\n\nThe link is valid for 15 minutes.`,
    });
  }

  async verifyMagicLink(token: string, locale = "en") {
    const [ml] = await this.o.db
      .select()
      .from(magicLinks)
      .where(and(eq(magicLinks.tokenHash, sha256(token)), gte(magicLinks.expiresAt, new Date()), isNull(magicLinks.usedAt)));
    if (!ml) throw new ForgeError("UNAUTHORIZED", "This link is invalid or has expired");
    await this.o.db.update(magicLinks).set({ usedAt: new Date() }).where(eq(magicLinks.id, ml.id));
    return this.loginOrCreateVerified(ml.email, "", locale);
  }

  /** Used by magic links and OAuth: the email is proven, so create the account if needed. */
  async loginOrCreateVerified(emailRaw: string, name: string, locale: string) {
    const email = normEmail(emailRaw);
    let [u] = await this.o.db.select().from(users).where(and(eq(users.email, email), isNull(users.deletedAt)));
    if (!u) u = (await this.createUser({ email, name, locale, verified: true })).user;
    else if (!u.emailVerified) await this.o.db.update(users).set({ emailVerified: true }).where(eq(users.id, u.id));
    const session = await this.createSession(u.id);
    return { user: this.toSessionUser(u), ...session };
  }
}
