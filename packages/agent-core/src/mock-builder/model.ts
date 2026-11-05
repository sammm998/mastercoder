import type { Entity, Field, Spec } from "../spec.js";
import { camel, kebab, label, pascal, plural, snake } from "./names.js";

/**
 * Normalised data model the generators work from: the spec's entities with derived names, input
 * kinds and validation rules. Rules are keyword heuristics on field names (documented per rule), not
 * guesses presented as requirements.
 */

export type FormKind = "text" | "number" | "boolean";

export interface FieldModel {
  name: string;
  type: Field["type"];
  required: boolean;
  enumValues: string[];
  /** Referenced entity name (only when it exists in the spec). */
  references?: string;
  label: string;
  column: string;
  kind: FormKind;
  /** Numeric bounds / string format derived from the field name. */
  min?: number;
  max?: number;
  maxLength: number;
  pattern?: { re: string; message: string; sample: string };
}

export interface EntityModel {
  name: string;
  camel: string;
  pluralCamel: string;
  pluralPascal: string;
  kebab: string;
  pluralKebab: string;
  table: string;
  /** URL path of the entity's screen (honours spec.screens when it names one). */
  route: string;
  label: string;
  labelPlural: string;
  description: string;
  ownerScoped: boolean;
  fields: FieldModel[];
  /** Field shown when the entity is referenced (first plain string field). */
  displayField?: string;
}

const PATTERNS: Array<{ match: RegExp; re: string; message: string; sample: string; maxLength: number }> = [
  { match: /^slug$/i, re: "^[a-z0-9]+(?:-[a-z0-9]+)*$", message: "Use lowercase letters, numbers and dashes", sample: "sample-post", maxLength: 120 },
  { match: /^sku$/i, re: "^[A-Za-z0-9_-]+$", message: "Use letters, numbers, dashes and underscores", sample: "SKU-001", maxLength: 64 },
  { match: /time$/i, re: "^([01]\\d|2[0-3]):[0-5]\\d$", message: "Use the 24-hour format HH:MM", sample: "07:30", maxLength: 5 },
  { match: /^quarter$/i, re: "^\\d{4}-Q[1-4]$", message: "Use the format YYYY-Q1..Q4", sample: "2026-Q1", maxLength: 7 },
];

function numericBounds(f: Field): { min?: number; max?: number } {
  const n = f.name.toLowerCase();
  if (f.type === "integer" && /(progress|percent)/.test(n)) return { min: 0, max: 100 };
  if (/(duration|minutes)/.test(n)) return { min: 1, max: 1440 };
  if (/(quantity|count|stock|qty)/.test(n)) return { min: 0 };
  if (/(price|amount|value|revenue|cost|target|current|total)/.test(n)) return { min: 0 };
  return {};
}

export function fieldModel(f: Field, entityNames: Set<string>): FieldModel {
  const pat = f.type === "string" ? PATTERNS.find((p) => p.match.test(f.name)) : undefined;
  const refName = f.type === "reference" && f.references && entityNames.has(f.references) ? f.references : undefined;
  return {
    name: f.name,
    type: f.type === "reference" && !refName ? "string" : f.type,
    required: f.type === "boolean" ? true : f.required,
    enumValues: f.type === "enum" ? (f.enumValues?.length ? f.enumValues : ["open", "closed"]) : [],
    references: refName,
    label: label(f.name),
    column: snake(f.name),
    kind: f.type === "number" || f.type === "integer" ? "number" : f.type === "boolean" ? "boolean" : "text",
    ...numericBounds(f),
    maxLength: pat?.maxLength ?? (f.type === "text" ? 5000 : f.type === "url" || f.type === "email" ? 320 : 200),
    pattern: pat ? { re: pat.re, message: pat.message, sample: pat.sample } : undefined,
  };
}

function safeRoute(p: string): string | null {
  return /^\/[a-z0-9-]+$/.test(p) ? p : null;
}

export function entityModel(e: Entity, spec: Pick<Spec, "screens" | "entities">): EntityModel {
  const names = new Set(spec.entities.map((x) => x.name));
  const pl = plural(e.name);
  const screen = spec.screens.find((s) => s.name === `${e.name}s` || s.name === pl);
  const fields = e.fields.filter((f) => !["id", "ownerId", "createdAt", "updatedAt"].includes(f.name)).map((f) => fieldModel(f, names));
  return {
    name: pascal(e.name),
    camel: camel(e.name),
    pluralCamel: camel(pl),
    pluralPascal: pascal(pl),
    kebab: kebab(e.name),
    pluralKebab: kebab(pl),
    table: snake(pl),
    route: (screen && safeRoute(screen.path)) ?? `/${kebab(pl)}`,
    label: label(e.name),
    labelPlural: label(pl),
    description: e.description,
    ownerScoped: e.ownerScoped,
    fields,
    displayField: fields.find((f) => f.type === "string" && !f.pattern && /(name|title)/i.test(f.name))?.name ?? fields.find((f) => f.type === "string")?.name,
  };
}

export function entityModels(spec: Pick<Spec, "screens" | "entities">): EntityModel[] {
  return spec.entities.map((e) => entityModel(e, spec));
}

// ------------------------------------------------------------------ zod

export type ZodTarget = "form" | "json";

/** Zod expression for one field. `form` = values from formValues() (datetime coerced to Date). */
export function zodFor(f: FieldModel, target: ZodTarget, refLabel?: string): string {
  let e: string;
  switch (f.type) {
    case "string":
    case "text":
      e = `z.string().trim()${f.required ? `.min(1, "Required")` : ""}.max(${f.maxLength})${f.pattern ? `.regex(/${f.pattern.re}/, ${JSON.stringify(f.pattern.message)})` : ""}`;
      break;
    case "email":
      e = `z.string().trim().max(${f.maxLength}).email("Enter a valid email address")`;
      break;
    case "url":
      e = `z.string().trim().max(${f.maxLength}).url("Enter a valid URL").refine((v) => /^https?:\\/\\//i.test(v), "Use an http(s) URL")`;
      break;
    case "number":
    case "integer":
      e = `z.number()${f.type === "integer" ? ".int()" : ""}${f.min !== undefined ? `.min(${f.min})` : ""}${f.max !== undefined ? `.max(${f.max})` : ""}`;
      break;
    case "boolean":
      e = "z.boolean()";
      break;
    case "date":
      e = `z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/, "Use YYYY-MM-DD").refine((v) => !Number.isNaN(Date.parse(v)), "Invalid date")`;
      break;
    case "datetime":
      e = target === "form" ? `z.coerce.date().refine((d) => !Number.isNaN(d.getTime()), "Invalid date and time")` : `z.string().datetime({ offset: true })`;
      break;
    case "enum":
      e = `z.enum([${f.enumValues.map((v) => JSON.stringify(v)).join(", ")}])`;
      break;
    case "reference":
      e = `z.string().uuid(${JSON.stringify(`Choose a ${(refLabel ?? f.label).toLowerCase()}`)})`;
      break;
  }
  return f.required || f.type === "boolean" ? e : `${e}.optional()`;
}

/** Deterministic valid sample value (for generated tests), as a JS literal. */
export function sampleFor(f: FieldModel, target: ZodTarget, i = 1): string {
  switch (f.type) {
    case "string":
      return JSON.stringify(f.pattern ? f.pattern.sample : `Sample ${f.label.toLowerCase()} ${i}`);
    case "text":
      return JSON.stringify(`Sample ${f.label.toLowerCase()} text`);
    case "email":
      return JSON.stringify(`person${i}@example.com`);
    case "url":
      return JSON.stringify("https://example.com");
    case "number":
      return String(f.min !== undefined && f.min > 10 ? f.min : 10 * i);
    case "integer":
      return String(f.max !== undefined ? Math.min(f.max, 50) : f.min !== undefined && f.min > 0 ? 30 : 3 * i);
    case "boolean":
      return "true";
    case "date":
      return JSON.stringify(`2026-01-${String(10 + i).padStart(2, "0")}`);
    case "datetime":
      return JSON.stringify(target === "form" ? `2026-01-${String(10 + i).padStart(2, "0")}T10:00` : `2026-01-${String(10 + i).padStart(2, "0")}T10:00:00Z`);
    case "enum":
      return JSON.stringify(f.enumValues[0] ?? "open");
    case "reference":
      return JSON.stringify(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
  }
}

/** An invalid value for a field (for "validation rejects" tests), or null when none is meaningful. */
export function invalidFor(f: FieldModel): string | null {
  switch (f.type) {
    case "string":
    case "text":
      return f.required ? '""' : JSON.stringify("x".repeat(f.maxLength + 1));
    case "email":
      return '"not-an-email"';
    case "url":
      return '"javascript:alert(1)"';
    case "number":
    case "integer":
      return f.min !== undefined ? String(f.min - 1) : '"not-a-number"';
    case "boolean":
      return '"yes"';
    case "date":
      return '"15/01/2026"';
    case "datetime":
      return '"not-a-date"';
    case "enum":
      return '"__not_a_valid_option__"';
    case "reference":
      return '"not-a-uuid"';
  }
}

export function htmlInputType(f: FieldModel): string {
  switch (f.type) {
    case "email":
      return "email";
    case "url":
      return "url";
    case "number":
    case "integer":
      return "number";
    case "date":
      return "date";
    case "datetime":
      return "datetime-local";
    case "boolean":
      return "checkbox";
    default:
      return "text";
  }
}

/** Slug used to identify the domain in summaries/tests. */
export function specText(spec: Pick<Spec, "title" | "summary" | "userStories">): string {
  return `${spec.title}\n${spec.summary}\n${spec.userStories.join("\n")}`;
}
