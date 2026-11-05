import type { Spec } from "../spec.js";
import type { EntityModel, FieldModel } from "./model.js";
import { specText } from "./model.js";
import { TS_HEADER, camel, kebab, pascal, plural, q, snake } from "./names.js";

/**
 * Domain rules the mock builder recognises from the data model shape (not from free text alone):
 * - booking: an entity with a datetime and a reference to a bookable resource → no double booking
 * - pipeline: an enum field named stage/status → ordered stages, grouping, next/previous moves
 * - progress: number fields target + current → percentage progress
 * - streak: a dated check-in entity referencing a parent → consecutive-day streaks
 * - csv: a CSV/sales spec with date + amount fields → upload, parse and chart
 */

export interface BookingRule {
  entity: EntityModel;
  start: FieldModel;
  resource: FieldModel;
  resourceEntity: EntityModel;
  /** Reference whose entity holds a duration in minutes (e.g. Service.durationMinutes). */
  duration?: { field: FieldModel; entity: EntityModel; durationField: FieldModel };
}

export interface PipelineRule {
  entity: EntityModel;
  field: FieldModel;
  values: string[];
}

export interface ProgressRule {
  entity: EntityModel;
  current: FieldModel;
  target: FieldModel;
}

export interface StreakRule {
  entity: EntityModel;
  date: FieldModel;
  parentField: FieldModel;
  parent: EntityModel;
}

export interface CsvRule {
  entity: EntityModel;
  date: FieldModel;
  amount: FieldModel;
  product?: FieldModel;
  quantity?: FieldModel;
}

export interface DomainRules {
  booking?: BookingRule;
  pipeline: PipelineRule[];
  progress: ProgressRule[];
  streak?: StreakRule;
  csv?: CsvRule;
}

const RESOURCE = /(stylist|staff|employee|resource|room|provider|barber|therapist|doctor|instructor|table|court|desk)/i;

export function detectRules(spec: Spec, models: EntityModel[]): DomainRules {
  const byName = new Map(models.map((m) => [m.name, m]));
  const text = specText(spec);
  const rules: DomainRules = { pipeline: [], progress: [] };

  for (const m of models) {
    const start = m.fields.find((f) => f.type === "datetime");
    const refs = m.fields.filter((f) => f.type === "reference" && f.references);
    const resource = refs.find((f) => RESOURCE.test(f.references ?? "")) ?? (/(booking|appointment|reservation)/i.test(m.name) ? refs[0] : undefined);
    if (!rules.booking && start && resource) {
      const resourceEntity = byName.get(resource.references ?? "");
      if (resourceEntity) {
        let duration: BookingRule["duration"];
        for (const r of refs) {
          const e = byName.get(r.references ?? "");
          const d = e?.fields.find((f) => (f.type === "integer" || f.type === "number") && /(duration|minutes)/i.test(f.name));
          if (e && d) duration = { field: r, entity: e, durationField: d };
        }
        rules.booking = { entity: m, start, resource, resourceEntity, duration };
      }
    }
    for (const f of m.fields) if (f.type === "enum" && /^(stage|status)$/i.test(f.name)) rules.pipeline.push({ entity: m, field: f, values: f.enumValues });
    const current = m.fields.find((f) => (f.type === "number" || f.type === "integer") && /^current/i.test(f.name));
    const target = m.fields.find((f) => (f.type === "number" || f.type === "integer") && /^target/i.test(f.name));
    if (current && target) rules.progress.push({ entity: m, current, target });
    const date = m.fields.find((f) => f.type === "date");
    if (!rules.streak && date && /(check.?in|log|entry|completion)/i.test(m.name)) {
      const parentField = refs[0];
      const parent = parentField ? byName.get(parentField.references ?? "") : undefined;
      if (parentField && parent) rules.streak = { entity: m, date, parentField, parent };
    }
  }
  if (/\bcsv\b|sales|revenue|försäljning|intäkt/i.test(text)) {
    for (const m of models) {
      const date = m.fields.find((f) => f.type === "date" || f.type === "datetime");
      const amount = m.fields.find((f) => f.type === "number" && /(revenue|amount|total|sales|price|value)/i.test(f.name)) ?? m.fields.find((f) => f.type === "number");
      if (date && amount) {
        rules.csv = {
          entity: m,
          date,
          amount,
          product: m.fields.find((f) => f.type === "string" && /(product|item|name|sku|category)/i.test(f.name)),
          quantity: m.fields.find((f) => f.type === "integer" && /(quantity|qty|units|count)/i.test(f.name)),
        };
        break;
      }
    }
  }
  return rules;
}

// ------------------------------------------------------------------ emitted TS modules

export function bookingRulesTs(): string {
  return `${TS_HEADER}
/** Booking rules: start times on a fixed slot grid, and no two bookings of one resource may overlap. */

/** Slot length of the booking form; start times must fall on this grid (local server time). */
export const SLOT_MINUTES = 15;

export interface Interval {
  start: Date;
  end: Date;
}

export interface ResourceInterval extends Interval {
  resourceId: string;
}

export function bookingEnd(start: Date, durationMinutes: number): Date {
  return new Date(start.getTime() + durationMinutes * 60_000);
}

/** Half-open intervals [start, end): a booking ending at 10:00 does not clash with one starting at 10:00. */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

export function isOnSlotGrid(d: Date, minutes: number = SLOT_MINUTES): boolean {
  return d.getSeconds() === 0 && d.getMilliseconds() === 0 && d.getMinutes() % minutes === 0;
}

/** First existing booking of the same resource that overlaps the candidate. */
export function findConflict<T extends ResourceInterval>(existing: readonly T[], candidate: ResourceInterval): T | undefined {
  return existing.find((e) => e.resourceId === candidate.resourceId && overlaps(e, candidate));
}

/**
 * True for Postgres unique_violation (23505) / exclusion_violation (23P01), also when wrapped by the
 * ORM: the database is the final guard against double booking (unique index + exclusion constraint).
 */
export function isConflictError(error: unknown): boolean {
  let cur: unknown = error;
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    const code = (cur as { code?: unknown }).code;
    if (code === "23505" || code === "23P01") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
`;
}

export function bookingRulesTest(importPath: string): string {
  return `${TS_HEADER}
import { describe, expect, it } from "vitest";
import { bookingEnd, findConflict, isConflictError, isOnSlotGrid, overlaps } from ${q(importPath)};

const at = (h: number, m = 0) => new Date(2026, 0, 15, h, m, 0, 0);

describe("booking rules", () => {
  it("computes the end from the service duration", () => {
    expect(bookingEnd(at(10), 45).getTime()).toBe(at(10, 45).getTime());
  });

  it("treats touching bookings as free and overlapping ones as taken", () => {
    expect(overlaps({ start: at(10), end: at(11) }, { start: at(11), end: at(12) })).toBe(false);
    expect(overlaps({ start: at(10), end: at(11) }, { start: at(10, 30), end: at(11, 30) })).toBe(true);
    expect(overlaps({ start: at(10), end: at(12) }, { start: at(10, 30), end: at(11) })).toBe(true);
  });

  it("rejects a double booking of the same resource but allows another resource", () => {
    const existing = [{ id: "b1", resourceId: "stylist-a", start: at(10), end: at(11) }];
    expect(findConflict(existing, { resourceId: "stylist-a", start: at(10, 30), end: at(11, 30) })?.id).toBe("b1");
    expect(findConflict(existing, { resourceId: "stylist-b", start: at(10, 30), end: at(11, 30) })).toBeUndefined();
    expect(findConflict(existing, { resourceId: "stylist-a", start: at(11), end: at(12) })).toBeUndefined();
  });

  it("only accepts start times on the slot grid", () => {
    expect(isOnSlotGrid(at(10, 15))).toBe(true);
    expect(isOnSlotGrid(at(10, 7))).toBe(false);
  });

  it("recognises database conflict errors, also when wrapped", () => {
    expect(isConflictError({ code: "23505" })).toBe(true);
    expect(isConflictError({ message: "query failed", cause: { code: "23P01" } })).toBe(true);
    expect(isConflictError(new Error("network"))).toBe(false);
  });
});
`;
}

export function pipelineName(r: PipelineRule): { constName: string; typeName: string; module: string } {
  const base = `${pascal(r.entity.name)}${pascal(r.field.name)}`;
  return { constName: snake(`${r.entity.name} ${plural(r.field.name)}`).toUpperCase(), typeName: base, module: `${kebab(r.entity.name)}-${kebab(r.field.name)}` };
}

export function pipelineTs(r: PipelineRule): string {
  const n = pipelineName(r);
  return `${TS_HEADER}
/** Ordered ${r.entity.label.toLowerCase()} ${r.field.label.toLowerCase()}s (pipeline columns, left to right). */
export const ${n.constName} = [${r.values.map(q).join(", ")}] as const;
export type ${n.typeName} = (typeof ${n.constName})[number];

export function is${n.typeName}(value: string): value is ${n.typeName} {
  return (${n.constName} as readonly string[]).includes(value);
}

export function ${camel(r.field.name)}Index(value: ${n.typeName}): number {
  return ${n.constName}.indexOf(value);
}

/** The next ${r.field.label.toLowerCase()} in the pipeline, or null at the end. */
export function next${pascal(r.field.name)}(value: ${n.typeName}): ${n.typeName} | null {
  return ${n.constName}[${camel(r.field.name)}Index(value) + 1] ?? null;
}

/** The previous ${r.field.label.toLowerCase()}, or null at the start. */
export function previous${pascal(r.field.name)}(value: ${n.typeName}): ${n.typeName} | null {
  const i = ${camel(r.field.name)}Index(value);
  return i > 0 ? (${n.constName}[i - 1] ?? null) : null;
}

/** Group items into pipeline columns, keeping every ${r.field.label.toLowerCase()} (empty columns included). */
export function groupBy${pascal(r.field.name)}<T extends { ${r.field.name}: string }>(items: readonly T[]): Record<${n.typeName}, T[]> {
  const out = Object.fromEntries(${n.constName}.map((s) => [s, [] as T[]])) as Record<${n.typeName}, T[]>;
  for (const item of items) if (is${n.typeName}(item.${r.field.name})) out[item.${r.field.name}].push(item);
  return out;
}
`;
}

export function pipelineTest(r: PipelineRule, importPath: string): string {
  const n = pipelineName(r);
  const f = pascal(r.field.name);
  const first = r.values[0] ?? "a";
  const second = r.values[1] ?? first;
  const last = r.values[r.values.length - 1] ?? first;
  return `${TS_HEADER}
import { describe, expect, it } from "vitest";
import { ${n.constName}, groupBy${f}, next${f}, previous${f} } from ${q(importPath)};

describe("${r.entity.label.toLowerCase()} ${r.field.label.toLowerCase()} pipeline", () => {
  it("moves forward and backward through the ${r.field.label.toLowerCase()}s", () => {
    expect(next${f}(${q(first)})).toBe(${q(second)});
    expect(previous${f}(${q(second)})).toBe(${q(first)});
    expect(previous${f}(${q(first)})).toBeNull();
    expect(next${f}(${q(last)})).toBeNull();
  });

  it("groups items into every column", () => {
    const groups = groupBy${f}([{ ${r.field.name}: ${q(first)} }, { ${r.field.name}: ${q(last)} }, { ${r.field.name}: "unknown" }]);
    expect(Object.keys(groups)).toEqual([...${n.constName}]);
    expect(groups[${q(first)}]).toHaveLength(1);
  });
});
`;
}

export function progressTs(): string {
  return `${TS_HEADER}
/** Progress as a whole percentage 0..100 (0 when the target is not positive). */
export function progressPercent(current: number, target: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(target) || target <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((current / target) * 100)));
}

/** Average of several progress percentages (0 for none). */
export function averageProgress(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}
`;
}

export function progressTest(importPath: string): string {
  return `${TS_HEADER}
import { describe, expect, it } from "vitest";
import { averageProgress, progressPercent } from ${q(importPath)};

describe("progress", () => {
  it("computes a clamped percentage", () => {
    expect(progressPercent(25, 100)).toBe(25);
    expect(progressPercent(150, 100)).toBe(100);
    expect(progressPercent(-5, 100)).toBe(0);
    expect(progressPercent(5, 0)).toBe(0);
  });

  it("averages progress", () => {
    expect(averageProgress([])).toBe(0);
    expect(averageProgress([50, 100])).toBe(75);
  });
});
`;
}

export function streakTs(): string {
  return `${TS_HEADER}
/** Streaks over ISO calendar dates (YYYY-MM-DD), independent of time zones. */

const DAY = 86_400_000;

function dayNumber(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.floor(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / DAY);
}

export function toIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return \`\${y}-\${m}-\${d}\`;
}

/** Consecutive days ending today (or yesterday, so the streak survives until the day is over). */
export function currentStreak(dates: readonly string[], today: string): number {
  const days = new Set(dates.map(dayNumber));
  let cursor = dayNumber(today);
  if (!days.has(cursor)) cursor -= 1;
  let n = 0;
  while (days.has(cursor)) {
    n++;
    cursor -= 1;
  }
  return n;
}

/** Longest run of consecutive days. */
export function longestStreak(dates: readonly string[]): number {
  const days = [...new Set(dates.map(dayNumber))].sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  let prev: number | undefined;
  for (const d of days) {
    run = prev !== undefined && d === prev + 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}

export function hasCheckIn(dates: readonly string[], day: string): boolean {
  return dates.includes(day);
}
`;
}

export function streakTest(importPath: string): string {
  return `${TS_HEADER}
import { describe, expect, it } from "vitest";
import { currentStreak, hasCheckIn, longestStreak, toIsoDate } from ${q(importPath)};

describe("streaks", () => {
  it("counts consecutive days ending today or yesterday", () => {
    expect(currentStreak(["2026-01-13", "2026-01-14", "2026-01-15"], "2026-01-15")).toBe(3);
    expect(currentStreak(["2026-01-13", "2026-01-14"], "2026-01-15")).toBe(2);
    expect(currentStreak(["2026-01-12"], "2026-01-15")).toBe(0);
    expect(currentStreak([], "2026-01-15")).toBe(0);
  });

  it("handles month boundaries and duplicates", () => {
    expect(currentStreak(["2026-01-31", "2026-02-01", "2026-02-01"], "2026-02-01")).toBe(2);
    expect(longestStreak(["2026-01-01", "2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07"])).toBe(3);
  });

  it("formats local dates and detects check-ins", () => {
    expect(toIsoDate(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(hasCheckIn(["2026-01-05"], "2026-01-05")).toBe(true);
  });
});
`;
}
