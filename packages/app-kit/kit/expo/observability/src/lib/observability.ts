import { Platform } from "react-native";

/**
 * Crash/error reporting for the mobile app to the Forge error ingest with the PUBLIC ingest key
 * (EXPO_PUBLIC_FORGE_ERROR_KEY: ingest-only). Wraps React Native's global error handler, so
 * fatal JS errors are reported before the default handler runs.
 */
interface ErrorUtilsShape {
  getGlobalHandler(): (error: unknown, isFatal?: boolean) => void;
  setGlobalHandler(handler: (error: unknown, isFatal?: boolean) => void): void;
}

let installed = false;
let sent = 0;

export function reportError(err: unknown, tags: Record<string, string> = {}): Promise<void> {
  const endpoint = process.env.EXPO_PUBLIC_FORGE_ERROR_INGEST_URL;
  const key = process.env.EXPO_PUBLIC_FORGE_ERROR_KEY;
  const e = err instanceof Error ? err : new Error(typeof err === "string" ? err : "Non-error thrown");
  if (!endpoint || !key || sent++ >= 20) return Promise.resolve();
  return fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      type: e.name,
      message: (e.message || "Unknown error").slice(0, 4000),
      stack: e.stack?.slice(0, 20_000),
      runtime: "mobile",
      environment: __DEV__ ? "development" : "production",
      timestamp: new Date().toISOString(),
      tags: { platform: Platform.OS, ...tags },
    }),
  })
    .then(() => undefined)
    .catch(() => undefined);
}

export function installErrorReporter(): void {
  if (installed) return;
  installed = true;
  const utils = (globalThis as { ErrorUtils?: ErrorUtilsShape }).ErrorUtils;
  if (!utils) return;
  const previous = utils.getGlobalHandler();
  utils.setGlobalHandler((error, isFatal) => {
    void reportError(error, { fatal: String(Boolean(isFatal)) }).finally(() => previous(error, isFatal));
  });
}
