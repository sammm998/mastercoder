import { TRPCClientError } from "@trpc/client";

export type ErrorKind = "not_configured" | "unauthorized" | "forbidden" | "not_found" | "rate_limited" | "bad_input" | "spend_cap" | "blocked" | "network" | "unknown";

export interface ErrorInfo {
  kind: ErrorKind;
  message: string;
  code?: string;
}

interface ErrorData {
  code?: string;
  forgeCode?: string;
  httpStatus?: number;
}

/**
 * Normalise anything thrown by the tRPC client into something the UI can explain. PRECONDITION_FAILED
 * covers both "service not configured" and domain preconditions (spend cap, gate failure, approval).
 */
export function errorInfo(err: unknown): ErrorInfo {
  if (err instanceof TRPCClientError) {
    const data = (err.data ?? {}) as ErrorData;
    const message = err.message || "Request failed";
    switch (data.code) {
      case "PRECONDITION_FAILED":
        if (data.forgeCode === "SPEND_CAP") return { kind: "spend_cap", message, code: data.code };
        if (data.forgeCode === "GATE_FAILED" || data.forgeCode === "APPROVAL_REQUIRED") return { kind: "blocked", message, code: data.code };
        if (/not configured/i.test(message)) return { kind: "not_configured", message, code: data.code };
        return { kind: "blocked", message, code: data.code };
      case "UNAUTHORIZED":
        return { kind: "unauthorized", message, code: data.code };
      case "FORBIDDEN":
        return { kind: "forbidden", message, code: data.code };
      case "NOT_FOUND":
        return { kind: "not_found", message, code: data.code };
      case "TOO_MANY_REQUESTS":
        return { kind: "rate_limited", message, code: data.code };
      case "BAD_REQUEST":
      case "UNPROCESSABLE_CONTENT":
        return { kind: "bad_input", message: zodMessage(message), code: data.code };
      default:
        if (!data.code) return { kind: "network", message };
        return { kind: "unknown", message, code: data.code };
    }
  }
  if (err instanceof TypeError) return { kind: "network", message: err.message };
  return { kind: "unknown", message: err instanceof Error ? err.message : String(err) };
}

/** tRPC serialises zod issues as a JSON array in the message; show the first human sentence. */
export function zodMessage(message: string): string {
  if (!message.trim().startsWith("[")) return message;
  try {
    const issues = JSON.parse(message) as Array<{ message?: string; path?: Array<string | number> }>;
    const first = issues[0];
    if (!first?.message) return message;
    return first.path?.length ? `${first.path.join(".")}: ${first.message}` : first.message;
  } catch {
    return message;
  }
}

export function isNotConfigured(err: unknown): boolean {
  return errorInfo(err).kind === "not_configured";
}
