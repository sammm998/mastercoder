/** Provider health classification for admin.providerHealth rows. */
export interface HealthRow {
  provider: string;
  ok: boolean;
  failures24h: number;
  checks24h: number;
}

export type HealthState = "ok" | "degraded" | "failing";

/** failing: latest check failed; degraded: latest ok but some failures in 24h; ok otherwise. */
export function healthState(r: HealthRow): HealthState {
  if (!r.ok) return "failing";
  if (r.failures24h > 0) return "degraded";
  return "ok";
}

/** Failing first, then degraded, then by provider name. */
export function sortByHealth<T extends HealthRow>(rows: T[]): T[] {
  const rank: Record<HealthState, number> = { failing: 0, degraded: 1, ok: 2 };
  return [...rows].sort((a, b) => rank[healthState(a)] - rank[healthState(b)] || a.provider.localeCompare(b.provider));
}

export function failureRate(r: HealthRow): number {
  return r.checks24h > 0 ? r.failures24h / r.checks24h : 0;
}
