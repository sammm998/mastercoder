import type { Locale } from "./config";

const tag = (l: Locale) => (l === "sv" ? "sv-SE" : "en-GB");

export function formatUsd(usd: number | null | undefined, locale: Locale, opts: { precise?: boolean } = {}): string {
  const v = usd ?? 0;
  const digits = opts.precise || (v > 0 && v < 1) ? 4 : 2;
  return new Intl.NumberFormat(tag(locale), { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: digits }).format(v);
}

export function formatNumber(n: number, locale: Locale): string {
  return new Intl.NumberFormat(tag(locale), { maximumFractionDigits: 2 }).format(n);
}

export function formatDate(d: Date | string | null | undefined, locale: Locale, withTime = true): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat(tag(locale), withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" }).format(date);
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 86400],
  ["month", 30 * 86400],
  ["week", 7 * 86400],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

export function formatRelative(d: Date | string, locale: Locale, now: Date = new Date()): string {
  const date = typeof d === "string" ? new Date(d) : d;
  const diff = (date.getTime() - now.getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(tag(locale), { numeric: "auto" });
  for (const [unit, secs] of UNITS) {
    if (Math.abs(diff) >= secs || unit === "second") return rtf.format(Math.round(diff / secs), unit);
  }
  return rtf.format(0, "second");
}
