import { NextResponse, type NextRequest } from "next/server";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
const PREVIEW_ORIGIN = process.env.NEXT_PUBLIC_PREVIEW_ORIGIN || "";

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Strict, nonce-based Content Security Policy for every page (security by default). */
export function buildCsp(nonce: string, opts: { dev: boolean; apiUrl: string; previewOrigin?: string }): string {
  const api = new URL(opts.apiUrl);
  const ws = `${api.protocol === "https:" ? "wss:" : "ws:"}//${api.host}`;
  // Live previews come from the preview origin (signed links) or the API preview proxy; deployed apps from
  // their own https origins. Plain http (and localhost) only when the API itself is local/dev.
  const preview = originOf(opts.previewOrigin);
  const insecure = opts.dev || api.protocol === "http:";
  const frames = ["'self'", api.origin, ...(preview ? [preview] : []), "https:", ...(insecure ? ["http:"] : [])];
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${opts.dev ? " 'unsafe-eval'" : ""}`,
    // Inline style attributes are used by SSR'd components and motion; scripts stay nonce-locked.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data: https: http:",
    "media-src 'self' blob: data: https: http:",
    "font-src 'self' data:",
    `connect-src 'self' ${api.origin} ${ws}${opts.dev ? " ws: http://localhost:*" : ""}`,
    // Live previews and deployed apps are served from sandbox/provider origins.
    `frame-src ${frames.join(" ")}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    `form-action 'self' ${api.origin}`,
    "frame-ancestors 'none'",
  ];
  if (api.protocol === "https:") directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV === "development", apiUrl: API_URL, previewOrigin: PREVIEW_ORIGIN });
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.svg|monaco).*)", missing: [{ type: "header", key: "next-router-prefetch" }] }],
};
