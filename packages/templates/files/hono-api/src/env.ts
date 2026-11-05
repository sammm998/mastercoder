import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Comma-separated list of allowed browser origins. Empty = same-origin only. */
  CORS_ORIGINS: z.string().default(""),
  /** Maximum request body size in bytes. */
  BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_000_000),
});

export type Env = z.infer<typeof EnvSchema>;

/** Validated process environment. Throws with a readable message on bad config. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}
