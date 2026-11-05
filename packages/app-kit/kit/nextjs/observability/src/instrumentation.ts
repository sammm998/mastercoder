import type { Instrumentation } from "next";

export function register(): void {
  // Error reporting needs no SDK initialisation; see onRequestError below.
}

/** Next.js calls this for every uncaught error in server components, route handlers and actions. */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  const { reportError } = await import("@/lib/observability");
  await reportError(err, {
    url: request.path,
    runtime: process.env.NEXT_RUNTIME === "edge" ? "edge" : "server",
    tags: { method: request.method, routePath: context.routePath, routeType: context.routeType, routerKind: context.routerKind },
  });
};
