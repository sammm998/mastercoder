import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { magicLink } from "better-auth/plugins";
import { db } from "@/db/client";
import * as authSchema from "@/db/auth-schema";
import { escapeHtml, sendEmail } from "@/lib/email";
import { site } from "@/lib/site";

const google =
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? { google: { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET } }
    : {};
const microsoft =
  process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET
    ? { microsoft: { clientId: process.env.MICROSOFT_CLIENT_ID, clientSecret: process.env.MICROSOFT_CLIENT_SECRET, tenantId: process.env.MICROSOFT_TENANT_ID ?? "common" } }
    : {};

/** Social providers that have credentials configured (shown on the sign-in page). */
export const enabledSocialProviders = [...Object.keys(google), ...Object.keys(microsoft)] as Array<"google" | "microsoft">;

function linkEmail(to: string, subject: string, intro: string, url: string) {
  return sendEmail({
    to,
    subject,
    text: `${intro}\n\n${url}\n\nIf you did not ask for this, you can ignore this email.`,
    html: `<p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(url)}">${escapeHtml(subject)}</a></p><p>If you did not ask for this, you can ignore this email.</p>`,
  });
}

export const auth = betterAuth({
  appName: site.name,
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    sendResetPassword: async ({ user, url }) => {
      await linkEmail(user.email, `Reset your ${site.name} password`, "Use this link to choose a new password:", url);
    },
  },
  socialProviders: { ...google, ...microsoft },
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        await linkEmail(email, `Sign in to ${site.name}`, "Use this link to sign in. It expires in a few minutes.", url);
      },
    }),
    // Must stay last: lets server actions set auth cookies.
    nextCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
