"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import superjson from "superjson";
import type { AppRouter } from "@forge/api";
import { API_URL } from "./env";

export type RouterInputs = inferRouterInputs<AppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();

export function makeTrpcClient(baseUrl: string = API_URL) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${baseUrl}/trpc`,
        transformer: superjson,
        maxURLLength: 4000,
        fetch: (url, init) => fetch(url, { ...(init as RequestInit), credentials: "include" }),
      }),
    ],
  });
}

/** Retry transient failures only; never retry auth/validation/precondition errors. */
export function shouldRetry(failureCount: number, err: unknown): boolean {
  if (failureCount >= 2) return false;
  if (err instanceof TRPCClientError) {
    const code = (err.data as { code?: string } | undefined)?.code;
    return !code || code === "INTERNAL_SERVER_ERROR" || code === "TIMEOUT";
  }
  return true;
}

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 15_000, retry: shouldRetry, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

export function TRPCReactProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(makeQueryClient);
  const [trpcClient] = useState(() => makeTrpcClient());
  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  );
}
