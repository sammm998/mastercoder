/** Scaling helpers for the hand-written SVG charts (no chart library). */

/** Smallest "nice" number (1, 2, 2.5, 5 × 10^k) that is >= value. 0 or negative → 1. */
export function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  for (const m of [1, 2, 2.5, 5, 10]) {
    const candidate = m * base;
    // Tolerate floating point noise (e.g. 0.30000000000000004).
    if (candidate >= value - base * 1e-9) return Number(candidate.toPrecision(12));
  }
  return 10 * base;
}

/**
 * Evenly spaced ticks from 0 to a nice maximum covering `max`, with about `count` intervals.
 * Returns the ticks and the axis maximum (the last tick).
 */
export function linearTicks(max: number, count = 4): { ticks: number[]; max: number } {
  const n = Math.max(1, Math.round(count));
  const step = niceCeil((max > 0 ? max : 1) / n);
  const top = Math.max(step, Math.ceil(Number(((max > 0 ? max : 1) / step).toPrecision(12))) * step);
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return { ticks, max: ticks[ticks.length - 1] ?? top };
}

/** Linear scale mapping [0, domainMax] onto [rangeMax, 0] (SVG y grows downward). */
export function yScale(domainMax: number, height: number): (v: number) => number {
  const d = domainMax > 0 ? domainMax : 1;
  return (v: number) => height - (Math.max(0, Math.min(v, d)) / d) * height;
}

/** Band layout: x position and width for `count` bars across `width`, with `gap` px between bars. */
export function bandLayout(count: number, width: number, gap = 2): { x: (i: number) => number; bandwidth: number } {
  if (count <= 0) return { x: () => 0, bandwidth: 0 };
  const totalGap = gap * (count - 1);
  const bandwidth = Math.max(1, (width - totalGap) / count);
  return { x: (i: number) => i * (bandwidth + gap), bandwidth };
}

export interface StackSegment {
  key: string;
  value: number;
  y0: number;
  y1: number;
}

/** Stack values bottom-up in the given key order; zero/negative values produce no segment. */
export function stackColumn(keys: string[], valueOf: (key: string) => number): StackSegment[] {
  const out: StackSegment[] = [];
  let acc = 0;
  for (const key of keys) {
    const value = valueOf(key);
    if (!(value > 0)) continue;
    out.push({ key, value, y0: acc, y1: acc + value });
    acc += value;
  }
  return out;
}

/** Preferred categorical slot (1-8) per well-known provider, so a provider keeps its color across ranges. */
export const PREFERRED_SLOT: Record<string, number> = {
  anthropic: 1,
  openai: 2,
  fal: 3,
  replicate: 4,
  elevenlabs: 5,
  deepgram: 6,
  e2b: 7,
  daytona: 8,
};

/**
 * Assign categorical slots so color follows the entity, not its rank: known providers get their preferred
 * slot when free; the rest take the lowest free slot in alphabetical order. "Other" gets slot 0 (neutral).
 */
export function assignSlots(keys: string[], other = "Other", slots = 8): Record<string, number> {
  const out: Record<string, number> = {};
  const used = new Set<number>();
  const named = keys.filter((k) => k !== other);
  for (const k of named) {
    const pref = PREFERRED_SLOT[k.toLowerCase()];
    if (pref && pref <= slots && !used.has(pref)) {
      out[k] = pref;
      used.add(pref);
    }
  }
  for (const k of [...named].sort((a, b) => a.localeCompare(b))) {
    if (out[k] !== undefined) continue;
    let s = 1;
    while (used.has(s) && s <= slots) s++;
    out[k] = s <= slots ? s : 0;
    if (s <= slots) used.add(s);
  }
  if (keys.includes(other)) out[other] = 0;
  return out;
}

/** Compact USD for axes/labels: $0, $0.42, $12, $1.2k, $3.4M. */
export function formatUsd(v: number): string {
  if (!Number.isFinite(v)) return "–";
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (a === 0) return "$0";
  if (a >= 1_000_000) return `${sign}$${trim(a / 1_000_000)}M`;
  if (a >= 1_000) return `${sign}$${trim(a / 1_000)}k`;
  if (a >= 10) return `${sign}$${Math.round(a)}`;
  if (a >= 1) return `${sign}$${trim(a)}`;
  if (a >= 0.01) return `${sign}$${a.toFixed(2)}`;
  return `${sign}<$0.01`;
}

/** Precise USD for tables and tooltips. */
export function formatUsdPrecise(v: number): string {
  if (!Number.isFinite(v)) return "–";
  const digits = Math.abs(v) < 1 && v !== 0 ? 4 : 2;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function trim(n: number): string {
  return n.toFixed(1).replace(/\.0$/, "");
}

/** Short day label: "2026-11-05" → "Nov 5". */
export function shortDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Indices of labels to show so at most `maxLabels` appear, always including first and last. */
export function labelIndices(count: number, maxLabels: number): number[] {
  if (count <= 0) return [];
  if (count <= maxLabels) return Array.from({ length: count }, (_, i) => i);
  const step = Math.ceil((count - 1) / Math.max(1, maxLabels - 1));
  const out: number[] = [];
  for (let i = 0; i < count - 1; i += step) out.push(i);
  const last = count - 1;
  if (out[out.length - 1] !== last) {
    // Drop the previous label if it would crowd the last one.
    if (out.length > 1 && last - (out[out.length - 1] ?? 0) < step / 2) out.pop();
    out.push(last);
  }
  return out;
}
