/** Pure helpers for the cost dashboard: pivoting admin.costs rows and detecting spend spikes. */

export interface CostRow {
  /** UTC day, YYYY-MM-DD (from to_char(date_trunc('day', at)) in the API). */
  day: string;
  provider: string;
  costUsd: number;
  quantity: number;
}

export interface DailyCosts {
  /** Contiguous list of days, oldest first; days with no usage are present with 0. */
  days: string[];
  /** Providers ordered by total spend (desc), with the long tail folded into "Other". */
  providers: string[];
  /** provider -> cost per day (aligned with `days`). */
  series: Record<string, number[]>;
  /** Total cost per day across providers. */
  totals: number[];
  /** Total cost per provider over the whole range. */
  providerTotals: Record<string, number>;
}

export const OTHER = "Other";

/** YYYY-MM-DD for a Date in UTC. */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The `count` UTC days ending at (and including) `end`, oldest first. */
export function dayRange(end: Date, count: number): string[] {
  const out: string[] = [];
  const base = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  for (let i = count - 1; i >= 0; i--) out.push(utcDay(new Date(base - i * 86_400_000)));
  return out;
}

/**
 * Pivot (day, provider, cost) rows into aligned per-provider series over a contiguous day range.
 * At most `maxSeries` providers keep their own series (fixed categorical palette size); the rest fold into "Other".
 */
export function pivotDaily(rows: CostRow[], opts: { days: number; today?: Date; maxSeries?: number }): DailyCosts {
  const days = dayRange(opts.today ?? new Date(), opts.days);
  const maxSeries = Math.max(1, opts.maxSeries ?? 8);
  const index = new Map(days.map((d, i) => [d, i]));

  const rawTotals = new Map<string, number>();
  for (const r of rows) {
    if (!index.has(r.day) || !Number.isFinite(r.costUsd)) continue;
    rawTotals.set(r.provider, (rawTotals.get(r.provider) ?? 0) + r.costUsd);
  }
  const ranked = [...rawTotals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([p]) => p);
  const needsOther = ranked.length > maxSeries;
  const kept = needsOther ? ranked.slice(0, maxSeries - 1) : ranked;
  const keptSet = new Set(kept);
  const providers = needsOther ? [...kept, OTHER] : kept;

  const series: Record<string, number[]> = {};
  for (const p of providers) series[p] = days.map(() => 0);
  for (const r of rows) {
    const i = index.get(r.day);
    if (i === undefined || !Number.isFinite(r.costUsd)) continue;
    const key = keptSet.has(r.provider) ? r.provider : OTHER;
    const s = series[key];
    if (s) s[i] = (s[i] ?? 0) + r.costUsd;
  }
  const totals = days.map((_, i) => providers.reduce((sum, p) => sum + (series[p]?.[i] ?? 0), 0));
  const providerTotals: Record<string, number> = {};
  for (const p of providers) providerTotals[p] = (series[p] ?? []).reduce((a, b) => a + b, 0);
  return { days, providers, series, totals, providerTotals };
}

export interface SpikeResult {
  today: number;
  /** Mean of the trailing window (the `window` days before today). */
  trailingMean: number;
  /** today / trailingMean, or null when the trailing mean is 0. */
  ratio: number | null;
  flagged: boolean;
  /** Number of trailing days actually available (may be < window early in a range). */
  trailingDays: number;
}

/**
 * Spend spike: the last value (today) compared with the mean of the preceding `window` values.
 * Flagged when today > factor × mean. When the trailing mean is 0, any spend at or above `minUsd`
 * (and above 0) is flagged as new spend. `minUsd` also suppresses alerts on trivially small amounts.
 */
export function detectSpike(values: number[], opts: { factor?: number; window?: number; minUsd?: number } = {}): SpikeResult {
  const factor = opts.factor ?? 2;
  const window = opts.window ?? 7;
  const minUsd = opts.minUsd ?? 0;
  const today = values.length ? (values[values.length - 1] ?? 0) : 0;
  const trailing = values.slice(Math.max(0, values.length - 1 - window), Math.max(0, values.length - 1));
  const trailingMean = trailing.length ? trailing.reduce((a, b) => a + b, 0) / trailing.length : 0;
  const ratio = trailingMean > 0 ? today / trailingMean : null;
  const aboveFloor = today > 0 && today >= minUsd;
  const flagged = aboveFloor && (trailingMean > 0 ? today > factor * trailingMean : trailing.length > 0);
  return { today, trailingMean, ratio, flagged, trailingDays: trailing.length };
}

/** Spike check for the total and every provider series; flagged providers sorted by today's spend. */
export function spikeReport(d: DailyCosts, opts: { factor?: number; window?: number; minUsd?: number } = {}) {
  const total = detectSpike(d.totals, opts);
  const providers = d.providers
    .map((p) => ({ provider: p, ...detectSpike(d.series[p] ?? [], opts) }))
    .filter((r) => r.flagged)
    .sort((a, b) => b.today - a.today);
  return { total, providers };
}
