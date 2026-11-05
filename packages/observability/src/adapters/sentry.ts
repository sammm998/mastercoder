import * as Sentry from "@sentry/node";
import type { ErrorContext, ErrorReporter } from "../errors.js";

/** Sentry (use an EU-region DSN, e.g. *.de.sentry.io, for data residency). */
export class SentryErrorReporter implements ErrorReporter {
  readonly name = "sentry";
  constructor(dsn: string, service: string) {
    Sentry.init({ dsn, environment: process.env.NODE_ENV ?? "development", serverName: service, sendDefaultPii: false, tracesSampleRate: 0 });
  }
  capture(error: unknown, ctx?: ErrorContext): string {
    return Sentry.captureException(error, { tags: ctx?.tags, extra: ctx?.extra, user: ctx?.user });
  }
  async flush(timeoutMs = 2000): Promise<void> {
    await Sentry.flush(timeoutMs);
  }
}
