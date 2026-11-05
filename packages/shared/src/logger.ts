type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEYS = /(secret|token|password|api[_-]?key|authorization|cookie)/i;

/** Redact likely-secret values from structured log fields. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

/** Structured JSON logger to stdout (one line per entry). */
export function createLogger(base: Record<string, unknown> = {}, level: Level = (process.env.LOG_LEVEL as Level) || "info"): Logger {
  const write = (l: Level, msg: string, fields?: Record<string, unknown>) => {
    if (order[l] < order[level]) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level: l, msg, ...(redact({ ...base, ...fields }) as object) });
    if (l === "error" || l === "warn") process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (f) => createLogger({ ...base, ...f }, level),
  };
}
