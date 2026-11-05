import { describe, it, expect, vi, afterEach } from "vitest";
import { TRPCClientError } from "@trpc/client";
import superjson from "superjson";
import { errorInfo, zodMessage, isNotConfigured } from "../src/lib/errors";
import { makeTrpcClient, shouldRetry } from "../src/lib/trpc";
import { oauthStartUrl, safeNext, wsUrl } from "../src/lib/env";
import { buildCsp } from "../src/proxy";

function trpcError(code: string, message: string, forgeCode?: string) {
  return new TRPCClientError(message, { result: { error: { message, code: -32000, data: { code, httpStatus: 400, forgeCode } } } } as never);
}

afterEach(() => vi.unstubAllGlobals());

describe("errorInfo", () => {
  it("maps 'not configured' preconditions to a calm notice", () => {
    const e = trpcError("PRECONDITION_FAILED", "media is not configured on this server");
    expect(errorInfo(e)).toMatchObject({ kind: "not_configured" });
    expect(isNotConfigured(e)).toBe(true);
    expect(isNotConfigured(trpcError("PRECONDITION_FAILED", "Intent router not configured"))).toBe(true);
  });

  it("distinguishes spend caps and gate blocks", () => {
    expect(errorInfo(trpcError("PRECONDITION_FAILED", "cap", "SPEND_CAP")).kind).toBe("spend_cap");
    expect(errorInfo(trpcError("PRECONDITION_FAILED", "gate", "GATE_FAILED")).kind).toBe("blocked");
  });

  it("maps auth, not found, rate limit and validation errors", () => {
    expect(errorInfo(trpcError("UNAUTHORIZED", "x")).kind).toBe("unauthorized");
    expect(errorInfo(trpcError("FORBIDDEN", "x")).kind).toBe("forbidden");
    expect(errorInfo(trpcError("NOT_FOUND", "x")).kind).toBe("not_found");
    expect(errorInfo(trpcError("TOO_MANY_REQUESTS", "x")).kind).toBe("rate_limited");
    const bad = errorInfo(trpcError("BAD_REQUEST", JSON.stringify([{ message: "Invalid email", path: ["email"] }])));
    expect(bad).toMatchObject({ kind: "bad_input", message: "email: Invalid email" });
  });

  it("treats fetch failures as network errors", () => {
    expect(errorInfo(new TypeError("Failed to fetch")).kind).toBe("network");
    expect(errorInfo("boom")).toMatchObject({ kind: "unknown", message: "boom" });
  });

  it("zodMessage leaves plain messages alone", () => {
    expect(zodMessage("plain")).toBe("plain");
    expect(zodMessage("[not json")).toBe("[not json");
  });
});

describe("retry policy", () => {
  it("never retries client errors and caps transient retries", () => {
    expect(shouldRetry(0, trpcError("UNAUTHORIZED", "x"))).toBe(false);
    expect(shouldRetry(0, trpcError("PRECONDITION_FAILED", "x"))).toBe(false);
    expect(shouldRetry(0, trpcError("INTERNAL_SERVER_ERROR", "x"))).toBe(true);
    expect(shouldRetry(0, new TypeError("Failed to fetch"))).toBe(true);
    expect(shouldRetry(2, new TypeError("Failed to fetch"))).toBe(false);
  });
});

describe("tRPC client", () => {
  it("sends cookies, uses superjson and the /trpc endpoint", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      const body = JSON.stringify([{ result: { data: superjson.serialize({ id: "usr_1", email: "a@b.se", name: "A", locale: "sv", isAdmin: false }) } }]);
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = makeTrpcClient("http://api.test");
    const me = await client.auth.me.query();
    expect(me).toMatchObject({ email: "a@b.se" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toMatch(/^http:\/\/api\.test\/trpc\/auth\.me\?batch=1/);
    expect(init?.credentials).toBe("include");
  });

  it("surfaces server errors as TRPCClientError with data.code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([{ error: superjson.serialize({ message: "Project not found", code: -32004, data: { code: "NOT_FOUND", httpStatus: 404 } }) }]), { status: 404, headers: { "content-type": "application/json" } })),
    );
    const client = makeTrpcClient("http://api.test");
    const err = await client.project.get.query({ projectId: "prj_x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TRPCClientError);
    expect(errorInfo(err)).toMatchObject({ kind: "not_found", message: "Project not found" });
  });
});

describe("URL helpers", () => {
  it("builds websocket URLs from the API base", () => {
    expect(wsUrl("/ws/events/prj_1", "http://localhost:4000")).toBe("ws://localhost:4000/ws/events/prj_1");
    expect(wsUrl("/ws/collab", "https://api.forge.eu")).toBe("wss://api.forge.eu/ws/collab");
  });

  it("builds OAuth start URLs with an encoded return path", () => {
    expect(oauthStartUrl("google", "/app?x=1", "http://api")).toBe("http://api/auth/oauth/google/start?returnTo=%2Fapp%3Fx%3D1");
  });

  it("only allows same-origin relative redirects", () => {
    expect(safeNext("/invite?token=abc")).toBe("/invite?token=abc");
    expect(safeNext("//evil.example")).toBe("/app");
    expect(safeNext("/\\evil.example")).toBe("/app");
    expect(safeNext("https://evil.example")).toBe("/app");
    expect(safeNext(undefined)).toBe("/app");
  });
});

describe("content security policy", () => {
  it("locks scripts to a nonce and allows the API and its websocket", () => {
    const csp = buildCsp("abc", { dev: false, apiUrl: "https://api.forge.eu" });
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("connect-src 'self' https://api.forge.eu wss://api.forge.eu");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("upgrade-insecure-requests");
    const dev = buildCsp("n", { dev: true, apiUrl: "http://localhost:4000" });
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).not.toContain("upgrade-insecure-requests");
  });
});
