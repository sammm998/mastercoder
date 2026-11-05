/** Locale-aware formatting helpers (pure). */

export function formatUsd(v: number, locale: string): string {
  const digits = v !== 0 && Math.abs(v) < 1 ? 3 : 2;
  return new Intl.NumberFormat(locale === "sv" ? "sv-SE" : "en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: digits }).format(v);
}

export function formatUsdRange(low: number, high: number, locale: string): string {
  return Math.abs(high - low) < 0.005 ? formatUsd(low, locale) : `${formatUsd(low, locale)} – ${formatUsd(high, locale)}`;
}

/** 0:07, 12:34, 1:02:03 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function formatBytes(n: number, locale: string): string {
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const nf = new Intl.NumberFormat(locale === "sv" ? "sv-SE" : "en-US", { maximumFractionDigits: v < 10 && i > 0 ? 1 : 0 });
  return `${nf.format(v)} ${units[i]}`;
}

export function formatPercent(fraction: number, locale: string): string {
  return new Intl.NumberFormat(locale === "sv" ? "sv-SE" : "en-US", { style: "percent", maximumFractionDigits: 0 }).format(Math.max(0, Math.min(1, fraction)));
}
