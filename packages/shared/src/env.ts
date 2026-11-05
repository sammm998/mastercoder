/** Read an env var with optional default. Throws if required and missing. */
export function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${name}`);
}

export function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env ${name} must be an integer, got "${v}"`);
  return n;
}

export function envList(name: string, fallback: string[] = []): string[] {
  const v = process.env[name];
  if (!v) return fallback;
  return v.split(",").map((s: string) => s.trim()).filter(Boolean);
}

export type AdapterFactories<T> = Record<string, () => T>;

export interface SelectedAdapter<T> {
  name: string;
  isMock: boolean;
  instance: T;
}

/**
 * Pick a provider adapter by env var. Every provider in Forge has at least one real adapter and one
 * adapter literally named "mock". The selection is logged by callers via `isMock`.
 */
export function selectAdapter<T>(envVar: string, factories: AdapterFactories<T>, fallback: string): SelectedAdapter<T> {
  const name = (process.env[envVar] || fallback).toLowerCase();
  const factory = factories[name];
  if (!factory) {
    throw new Error(`Unknown ${envVar}="${name}". Valid: ${Object.keys(factories).join(", ")}`);
  }
  return { name, isMock: name === "mock", instance: factory() };
}
