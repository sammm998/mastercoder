import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TRPCClientError, httpBatchLink, type TRPCLink } from "@trpc/client";
import { createTRPCReact } from "@trpc/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import superjson from "superjson";
import type { AppRouter } from "@forge/api";
import { API_URL } from "./config";
import { tokenStore } from "./storage";
import type { TFunction } from "./lib/i18n";

export const trpc = createTRPCReact<AppRouter>();
export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type SessionUser = NonNullable<RouterOutputs["auth"]["me"]>;

interface SessionValue {
  status: "loading" | "signedOut" | "signedIn";
  token: string | null;
  /** Read the token at call time (for WebSockets and raw uploads). */
  getToken(): string | null;
  signIn(token: string): Promise<void>;
  signOut(): Promise<void>;
}

const SessionCtx = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const v = useContext(SessionCtx);
  if (!v) throw new Error("useSession outside ApiProvider");
  return v;
}

const NO_RETRY = new Set(["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "BAD_REQUEST", "PRECONDITION_FAILED", "TOO_MANY_REQUESTS"]);

export function errorCode(e: unknown): string | undefined {
  if (e instanceof TRPCClientError) return ((e as TRPCClientError<AppRouter>).data as { code?: string } | undefined)?.code;
  return undefined;
}

/** User-facing message for any API error, in the current language. */
export function errorText(e: unknown, t: TFunction): string {
  const code = errorCode(e);
  const msg = e instanceof Error ? e.message : String(e);
  if (code === "UNAUTHORIZED") return t("errors.unauthorized");
  if (code === "FORBIDDEN") return t("errors.forbidden");
  if (code === "NOT_FOUND") return t("errors.notFound");
  if (code === "TOO_MANY_REQUESTS") return t("errors.rateLimited");
  if (code === "PRECONDITION_FAILED") return /spend|cap/i.test(msg) ? t("chat.spendCap") : t("chat.notConfigured", { message: msg });
  if (e instanceof TRPCClientError && !code) return t("errors.network");
  return t("errors.generic", { message: msg });
}

/**
 * Session (token in SecureStore, sent as `Authorization: Bearer`) + tRPC/React Query. The API also sets a
 * cookie on login; requests use `credentials: "omit"` so only the Bearer token authenticates.
 */
export function ApiProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState<SessionValue["status"]>("loading");
  const tokenRef = useRef<string | null>(null);

  const onUnauthorized = useRef<() => void>(() => undefined);

  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 10_000, retry: (n, err) => !NO_RETRY.has(errorCode(err) ?? "") && n < 2 },
          mutations: { retry: false },
        },
      }),
  );

  const [client] = useState(() => {
    // Signs out locally when the server says the session is gone (expired/revoked).
    const authWatch: TRPCLink<AppRouter> = () => ({ next, op }) =>
      observable((observer) =>
        next(op).subscribe({
          next: (v) => observer.next(v),
          error: (err) => {
            if (errorCode(err) === "UNAUTHORIZED" && tokenRef.current) onUnauthorized.current();
            observer.error(err);
          },
          complete: () => observer.complete(),
        }),
      );
    return trpc.createClient({
      links: [
        authWatch,
        httpBatchLink({
          url: `${API_URL}/trpc`,
          transformer: superjson,
          headers: () => (tokenRef.current ? { authorization: `Bearer ${tokenRef.current}` } : {}),
          fetch: (url, init) => fetch(url, { ...(init as RequestInit), credentials: "omit" }),
        }),
      ],
    });
  });

  useEffect(() => {
    void tokenStore.get().then((t) => {
      tokenRef.current = t;
      setToken(t);
      setStatus(t ? "signedIn" : "signedOut");
    });
  }, []);

  const signIn = useCallback(
    async (t: string) => {
      await tokenStore.set(t);
      tokenRef.current = t;
      setToken(t);
      queryClient.clear();
      setStatus("signedIn");
    },
    [queryClient],
  );

  const signOut = useCallback(async () => {
    const t = tokenRef.current;
    if (t) {
      // Revoke server-side; ignore failures (offline) — the local token is removed regardless.
      await fetch(`${API_URL}/trpc/auth.logout`, { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: "{}", credentials: "omit" }).catch(() => undefined);
    }
    await tokenStore.clear();
    tokenRef.current = null;
    setToken(null);
    queryClient.clear();
    setStatus("signedOut");
  }, [queryClient]);

  onUnauthorized.current = () => void signOut();

  const value = useMemo<SessionValue>(() => ({ status, token, getToken: () => tokenRef.current, signIn, signOut }), [status, token, signIn, signOut]);

  return (
    <SessionCtx.Provider value={value}>
      <trpc.Provider client={client} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </trpc.Provider>
    </SessionCtx.Provider>
  );
}
