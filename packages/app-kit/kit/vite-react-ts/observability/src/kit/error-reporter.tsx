import { useEffect } from "react";
import { reportError } from "../lib/report-error";

/** Reports uncaught errors and unhandled promise rejections. */
export function ErrorReporter() {
  useEffect(() => {
    const onError = (ev: ErrorEvent) => reportError(ev.error ?? ev.message);
    const onRejection = (ev: PromiseRejectionEvent) => reportError(ev.reason);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
