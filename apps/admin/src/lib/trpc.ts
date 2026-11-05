"use client";
import { createTRPCReact, type inferReactQueryProcedureOptions } from "@trpc/react-query";
import { TRPCClientError, httpBatchLink } from "@trpc/client";
import type { inferRouterOutputs } from "@trpc/server";
import superjson from "superjson";
import type { AppRouter } from "@forge/api";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000").replace(/\/$/, "");

export const trpc = createTRPCReact<AppRouter>();

export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type ReactQueryOptions = inferReactQueryProcedureOptions<AppRouter>;

/**
 * The session lives in the API's httpOnly `forge_session` cookie (set by auth.login). The admin app
 * never sees the token; it only sends the cookie (admin and API must be same-site).
 */
export function createClient() {
  return trpc.createClient({
    links: [
      httpBatchLink({
        url: `${API_URL}/trpc`,
        transformer: superjson,
        fetch: (url, init) => fetch(url, { ...(init as RequestInit), credentials: "include" }),
      }),
    ],
  });
}

/** tRPC error code (e.g. "FORBIDDEN") of an unknown error, if any. */
export function errorCode(e: unknown): string | undefined {
  if (e instanceof TRPCClientError) {
    const data = (e as TRPCClientError<AppRouter>).data as { code?: string } | undefined;
    return data?.code;
  }
  return undefined;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
