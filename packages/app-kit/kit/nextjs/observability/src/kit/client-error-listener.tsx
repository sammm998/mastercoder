"use client";

import { useEffect } from "react";

export function sendClientError(err: unknown): void {
  const e = err instanceof Error ? err : new Error(typeof err === "string" ? err : "Non-error thrown");
  const body = JSON.stringify({ type: e.name, message: e.message || "Unknown error", stack: e.stack?.slice(0, 20_000), url: window.location.pathname });
  void fetch("/api/client-errors", { method: "POST", body, keepalive: true, headers: { "Content-Type": "application/json" } }).catch(() => undefined);
}

/** Reports uncaught browser errors and unhandled promise rejections (max 10 per page view). */
export function ClientErrorListener() {
  useEffect(() => {
    let sent = 0;
    const onError = (ev: ErrorEvent) => {
      if (sent++ < 10) sendClientError(ev.error ?? ev.message);
    };
    const onRejection = (ev: PromiseRejectionEvent) => {
      if (sent++ < 10) sendClientError(ev.reason);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
