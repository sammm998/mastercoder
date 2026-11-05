import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { db } from "../db/client.js";
import * as authSchema from "../db/auth-schema.js";
import { escapeHtml, sendEmail } from "./email.js";

const APP_NAME = process.env.APP_NAME ?? "{{projectName}}";

const google =
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? { google: { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET } }
    : {};
const microsoft =
  process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET
    ? { microsoft: { clientId: process.env.MICROSOFT_CLIENT_ID, clientSecret: process.env.MICROSOFT_CLIENT_SECRET, tenantId: process.env.MICROSOFT_TENANT_ID ?? "common" } }
    : {};

function linkEmail(to: string, subject: string, intro: string, url: string) {
  return sendEmail({
    to,
    subject,
    text: `${intro}\n\n${url}\n\nIf you did not ask for this, you can ignore this email.`,
    html: `<p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(url)}">${escapeHtml(subject)}</a></p>`,
  });
}

/** Browser origins allowed to use cookie sessions cross-origin (CORS_ORIGINS). */
export const trustedOrigins = (process.env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export const auth = betterAuth({
  appName: APP_NAME,
  baseURL: process.env.BETTER_AUTH_URL,
  basePath: "/api/auth",
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins,
  database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    sendResetPassword: async ({ user, url }) => {
      await linkEmail(user.email, `Reset your ${APP_NAME} password`, "Use this link to choose a new password:", url);
    },
  },
  socialProviders: { ...google, ...microsoft },
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        await linkEmail(email, `Sign in to ${APP_NAME}`, "Use this link to sign in. It expires in a few minutes.", url);
      },
    }),
  ],
});

export type AuthSession = typeof auth.$Infer.Session;
