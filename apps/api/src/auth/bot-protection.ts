import { selectAdapter } from "@forge/shared";

export interface BotCheckInput {
  token?: string;
  ip: string;
  /** Honeypot field: humans never fill it. */
  website?: string;
  /** Milliseconds the form was open before submit. */
  elapsedMs?: number;
}

export interface BotProtection {
  readonly name: string;
  verify(input: BotCheckInput): Promise<{ ok: boolean; reason?: string }>;
}

/** Cloudflare Turnstile server-side verification. */
export class TurnstileBotProtection implements BotProtection {
  readonly name = "turnstile";
  constructor(private readonly secret: string) {}
  async verify(input: BotCheckInput) {
    if (input.website) return { ok: false, reason: "honeypot" };
    if (!input.token) return { ok: false, reason: "missing captcha token" };
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: this.secret, response: input.token, remoteip: input.ip }),
    });
    const data = (await res.json()) as { success: boolean; "error-codes"?: string[] };
    return data.success ? { ok: true } : { ok: false, reason: (data["error-codes"] ?? []).join(",") || "captcha failed" };
  }
}

/** Honeypot + minimum fill-time heuristic, used when no captcha secret is configured. */
export class HeuristicBotProtection implements BotProtection {
  readonly name = "heuristic";
  async verify(input: BotCheckInput) {
    if (input.website) return { ok: false, reason: "honeypot" };
    if (input.elapsedMs !== undefined && input.elapsedMs < 1500) return { ok: false, reason: "submitted too fast" };
    return { ok: true };
  }
}

export function createBotProtection(): BotProtection {
  const secret = process.env.TURNSTILE_SECRET;
  return selectAdapter<BotProtection>(
    "BOT_PROTECTION_PROVIDER",
    {
      turnstile: () => new TurnstileBotProtection(secret ?? ""),
      heuristic: () => new HeuristicBotProtection(),
      mock: () => new HeuristicBotProtection(),
    },
    secret ? "turnstile" : "heuristic",
  ).instance;
}
