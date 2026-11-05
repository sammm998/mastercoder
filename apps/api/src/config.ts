import { envInt } from "@forge/shared";
import type { ApiConfig } from "./deps.js";

export function loadConfig(): ApiConfig {
  const appUrl = process.env.APP_URL || "http://localhost:3000";
  return {
    appUrl,
    apiUrl: process.env.API_URL || "http://localhost:4000",
    cookieSecure: appUrl.startsWith("https://"),
    sessionDays: envInt("SESSION_DAYS", 30),
    rateLimitPerMinUser: envInt("RATE_LIMIT_PER_MIN_USER", 120),
    rateLimitPerMinIp: envInt("RATE_LIMIT_PER_MIN_IP", 300),
    oauth: {
      google: process.env.GOOGLE_CLIENT_ID ? { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "" } : undefined,
      microsoft: process.env.MICROSOFT_CLIENT_ID
        ? { clientId: process.env.MICROSOFT_CLIENT_ID, clientSecret: process.env.MICROSOFT_CLIENT_SECRET ?? "", tenant: process.env.MICROSOFT_TENANT || "common" }
        : undefined,
    },
  };
}
