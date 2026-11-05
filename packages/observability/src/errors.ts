import { selectAdapter } from "@forge/shared";

export interface ErrorContext {
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  user?: { id: string };
}

export interface ErrorReporter {
  readonly name: string;
  capture(error: unknown, ctx?: ErrorContext): string;
  flush(timeoutMs?: number): Promise<void>;
}

/** Keeps captured errors in memory; logs them as JSON. Used when SENTRY_DSN is unset and in tests. */
export class MockErrorReporter implements ErrorReporter {
  readonly name = "mock";
  readonly captured: Array<{ id: string; message: string; ctx?: ErrorContext }> = [];
  capture(error: unknown, ctx?: ErrorContext): string {
    const id = `err_${this.captured.length + 1}`;
    this.captured.push({ id, message: error instanceof Error ? error.message : String(error), ctx });
    return id;
  }
  async flush(): Promise<void> {}
}

export async function createErrorReporter(service: string): Promise<ErrorReporter> {
  const dsn = process.env.SENTRY_DSN;
  if (dsn && (process.env.ERROR_REPORTER ?? "sentry") === "sentry") {
    const { SentryErrorReporter } = await import("./adapters/sentry.js");
    return new SentryErrorReporter(dsn, service);
  }
  return selectAdapter<ErrorReporter>("ERROR_REPORTER", { mock: () => new MockErrorReporter(), sentry: () => new MockErrorReporter() }, "mock").instance;
}
