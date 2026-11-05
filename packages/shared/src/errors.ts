export type ForgeErrorCode =
  | "BAD_INPUT"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "SPEND_CAP"
  | "MODERATION_BLOCKED"
  | "GATE_FAILED"
  | "APPROVAL_REQUIRED"
  | "PROVIDER_ERROR"
  | "SANDBOX_ERROR"
  | "LOOP_GUARD"
  | "INTERNAL";

export class ForgeError extends Error {
  constructor(
    public readonly code: ForgeErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ForgeError";
  }
}

export function isForgeError(e: unknown): e is ForgeError {
  return e instanceof ForgeError;
}
