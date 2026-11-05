import type { EntityModel, FieldModel } from "./model.js";
import { entityModels, invalidFor, sampleFor, zodFor } from "./model.js";
import { detectRules, pipelineName, pipelineTest, pipelineTs, progressTest, progressTs, streakTest, streakTs, type CsvRule, type DomainRules } from "./domain.js";
import { TS_HEADER, jsxText, q } from "./names.js";
import { appCss, fieldControlTsx, fieldDescriptorsLiteral, fieldKindsLiteral, formLibTs, healthRoute } from "./web-shared.js";
import { emptyProject, type GenerateContext, type GeneratedProject } from "./types.js";
import { ZOD_VERSION } from "./gen-nextjs-auth.js";
import { generateIntegration } from "./gen-openapi.js";

/**
 * Client-side app generator (Vite + React, or Next.js without accounts): zod-validated entity
 * modules persisted with a clearly named browser localStorage adapter, an accessible generic
 * create/edit/delete manager, and a CSV upload dashboard with SVG charts for sales-style specs.
 */

type Flavor = "vite" | "next";

const directive = (fl: Flavor) => (fl === "next" ? `"use client";\n` : "");

export function storageTs(): string {
  return `${TS_HEADER}
/** Key/value persistence. In the browser this is localStorage (data stays on this device only). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** In-memory store (tests, server rendering, or when localStorage is unavailable). */
export function memoryStore(): KeyValueStore {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

const fallback = memoryStore();

/** Browser localStorage adapter, falling back to memory (private mode, SSR). */
export function localStorageStore(): KeyValueStore {
  return {
    getItem(key) {
      try {
        return typeof window !== "undefined" && window.localStorage ? window.localStorage.getItem(key) : fallback.getItem(key);
      } catch {
        return fallback.getItem(key);
      }
    },
    setItem(key, value) {
      try {
        if (typeof window !== "undefined" && window.localStorage) window.localStorage.setItem(key, value);
        else fallback.setItem(key, value);
      } catch {
        fallback.setItem(key, value);
      }
    },
  };
}
`;
}

export function repositoryTs(): string {
  return `${TS_HEADER}
import type { z } from "zod";
import { fieldErrors } from "./form";
import { localStorageStore, type KeyValueStore } from "./storage";

export type Stored<T> = T & { id: string; createdAt: string; updatedAt: string };
export type SaveResult<T> = { ok: true; value: Stored<T> } | { ok: false; errors: Record<string, string[]> };

export interface Repository<T> {
  /** Current items (stable reference until something changes; usable with useSyncExternalStore). */
  list(): Stored<T>[];
  /** Empty list for server rendering. */
  serverList(): Stored<T>[];
  get(id: string): Stored<T> | undefined;
  create(input: unknown): SaveResult<T>;
  update(id: string, input: unknown): SaveResult<T>;
  remove(id: string): boolean;
  subscribe(listener: () => void): () => void;
}

const EMPTY: never[] = [];

function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : \`id-\${Date.now().toString(36)}-\${Math.random().toString(36).slice(2, 10)}\`;
}

/**
 * Validated collection persisted as JSON under \`key\`. Every write is validated with \`schema\`; rows
 * read back from storage are validated too, and corrupt rows are dropped instead of crashing the app.
 */
export function createRepository<T extends Record<string, unknown>>(key: string, schema: z.ZodType<T>, store: KeyValueStore = localStorageStore()): Repository<T> {
  const listeners = new Set<() => void>();
  let raw: string | null | undefined;
  let cache: Stored<T>[] = [];

  function load(): Stored<T>[] {
    const current = store.getItem(key);
    if (current === raw) return cache;
    raw = current;
    let parsed: unknown;
    try {
      parsed = current ? JSON.parse(current) : [];
    } catch {
      parsed = [];
    }
    cache = (Array.isArray(parsed) ? parsed : []).flatMap((row: unknown) => {
      if (!row || typeof row !== "object") return [];
      const { id, createdAt, updatedAt, ...rest } = row as Record<string, unknown>;
      const value = schema.safeParse(rest);
      if (!value.success || typeof id !== "string") return [];
      return [{ ...value.data, id, createdAt: String(createdAt ?? ""), updatedAt: String(updatedAt ?? "") }];
    });
    return cache;
  }

  function save(items: Stored<T>[]): void {
    raw = JSON.stringify(items);
    cache = items;
    store.setItem(key, raw);
    for (const l of listeners) l();
  }

  return {
    list: load,
    serverList: () => EMPTY,
    get: (id) => load().find((x) => x.id === id),
    create(input) {
      const r = schema.safeParse(input);
      if (!r.success) return { ok: false, errors: fieldErrors(r.error.issues) };
      const now = new Date().toISOString();
      const value = { ...r.data, id: newId(), createdAt: now, updatedAt: now } as Stored<T>;
      save([value, ...load()]);
      return { ok: true, value };
    },
    update(id, input) {
      const r = schema.safeParse(input);
      if (!r.success) return { ok: false, errors: fieldErrors(r.error.issues) };
      const existing = load().find((x) => x.id === id);
      if (!existing) return { ok: false, errors: { form: ["Not found"] } };
      const value = { ...r.data, id, createdAt: existing.createdAt, updatedAt: new Date().toISOString() } as Stored<T>;
      save(load().map((x) => (x.id === id ? value : x)));
      return { ok: true, value };
    },
    remove(id) {
      const items = load();
      if (!items.some((x) => x.id === id)) return false;
      save(items.filter((x) => x.id !== id));
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
`;
}

export function entityTs(m: EntityModel, models: EntityModel[]): string {
  const refLabel = (f: FieldModel) => models.find((x) => x.name === f.references)?.label;
  return `${TS_HEADER}
import { z } from "zod";
import type { FieldDescriptor, FieldKind } from "./form";
import { createRepository } from "./repository";

/** How each ${m.label.toLowerCase()} form field is read from FormData. */
export const ${m.camel}Fields = ${fieldKindsLiteral(m)} as const satisfies Record<string, FieldKind>;

export const ${m.camel}Schema = z.object({
${m.fields.map((f) => `  ${f.name}: ${zodFor(f, "json", refLabel(f)).replace('z.string().datetime({ offset: true })', 'z.string().regex(/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}/, "Use date and time")')},`).join("\n")}
});

export type ${m.name}Input = z.infer<typeof ${m.camel}Schema>;

export const ${m.camel}FormFields: FieldDescriptor[] = ${fieldDescriptorsLiteral(m, models)};

/** ${m.labelPlural} saved in this browser's localStorage (key ${q(`forge.${m.pluralKebab}`)}). */
export const ${m.camel}Repository = createRepository<${m.name}Input>(${q(`forge.${m.pluralKebab}`)}, ${m.camel}Schema);
`;
}

function managerTsx(fl: Flavor): string {
  return `${directive(fl)}${TS_HEADER}
import { useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { FieldControl } from "./field-control";
import { formValues, type FieldDescriptor, type FieldKind } from "../lib/form";
import type { Repository, Stored } from "../lib/repository";

export interface ExtraColumn {
  label: string;
  render: (item: Stored<Record<string, unknown>>) => ReactNode;
}

function display(field: FieldDescriptor, value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (field.input === "select") return field.options?.find((o) => o.value === value)?.label ?? String(value);
  if (field.input === "datetime-local" && typeof value === "string") return value.replace("T", " ");
  return String(value);
}

function defaults(item: Record<string, unknown> | null): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  if (!item) return out;
  for (const [k, v] of Object.entries(item)) out[k] = typeof v === "boolean" ? v : v === undefined || v === null ? "" : String(v);
  return out;
}

function withoutMeta(item: Stored<Record<string, unknown>>): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...item };
  delete rest.id;
  delete rest.createdAt;
  delete rest.updatedAt;
  return rest;
}

/** Accessible create / list / edit / delete UI for one entity. */
export function EntityManager({
  idPrefix,
  title,
  singular,
  fields,
  kinds,
  repository,
  extraColumns = [],
}: {
  idPrefix: string;
  title: string;
  singular: string;
  fields: FieldDescriptor[];
  kinds: Record<string, FieldKind>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  repository: Repository<any>;
  extraColumns?: ExtraColumn[];
}) {
  const items = useSyncExternalStore(repository.subscribe, repository.list, repository.serverList) as Stored<Record<string, unknown>>[];
  const [editing, setEditing] = useState<Stored<Record<string, unknown>> | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [status, setStatus] = useState("");
  const toggles = fields.filter((f) => f.input === "checkbox");
  const shown = fields.filter((f) => f.input !== "textarea" && f.input !== "checkbox").slice(0, 5);
  const labelOf = (item: Record<string, unknown>) => String(item[shown[0]?.name ?? "id"] ?? item.id);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const values = formValues(new FormData(form), kinds);
    const result = editing ? repository.update(editing.id, values) : repository.create(values);
    if (!result.ok) {
      setErrors(result.errors);
      setStatus("Please fix the highlighted fields.");
      return;
    }
    setErrors({});
    setStatus(editing ? \`\${singular} updated.\` : \`\${singular} added.\`);
    setEditing(null);
    form.reset();
  }

  return (
    <section className="card" aria-labelledby={\`\${idPrefix}-heading\`}>
      <h2 id={\`\${idPrefix}-heading\`}>{title}</h2>
      <form key={editing?.id ?? "new"} onSubmit={onSubmit} noValidate aria-label={editing ? \`Edit \${singular.toLowerCase()}\` : \`New \${singular.toLowerCase()}\`}>
        {fields.map((field) => (
          <FieldControl key={field.name} field={field} id={\`\${idPrefix}-field-\${field.name}\`} error={errors[field.name]?.join(" ")} defaultValue={defaults(editing)[field.name]} />
        ))}
        <p className="row-actions">
          <button className="button" type="submit">
            {editing ? "Save changes" : \`Add \${singular.toLowerCase()}\`}
          </button>
          {editing ? (
            <button className="button" data-variant="ghost" type="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
          ) : null}
        </p>
        <p role="status" aria-live="polite" className={Object.keys(errors).length ? "form-status-error" : undefined}>
          {status}
        </p>
      </form>
      {items.length === 0 ? (
        <p>Nothing here yet.</p>
      ) : (
        <table className="data-table">
          <caption className="visually-hidden">{title}</caption>
          <thead>
            <tr>
              {toggles.map((f) => (
                <th key={f.name} scope="col">
                  {f.label}
                </th>
              ))}
              {shown.map((f) => (
                <th key={f.name} scope="col">
                  {f.label}
                </th>
              ))}
              {extraColumns.map((c) => (
                <th key={c.label} scope="col">
                  {c.label}
                </th>
              ))}
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                {toggles.map((f) => (
                  <td key={f.name}>
                    <input
                      type="checkbox"
                      checked={item[f.name] === true}
                      aria-label={\`\${f.label}: \${labelOf(item)}\`}
                      onChange={() => repository.update(item.id, { ...withoutMeta(item), [f.name]: item[f.name] !== true })}
                    />
                  </td>
                ))}
                {shown.map((f) => (
                  <td key={f.name}>{display(f, item[f.name])}</td>
                ))}
                {extraColumns.map((c) => (
                  <td key={c.label}>{c.render(item)}</td>
                ))}
                <td>
                  <span className="row-actions">
                    <button className="button" data-variant="ghost" type="button" onClick={() => setEditing(item)}>
                      Edit<span className="visually-hidden"> {labelOf(item)}</span>
                    </button>
                    <button className="button" data-variant="ghost" type="button" onClick={() => repository.remove(item.id)}>
                      Delete<span className="visually-hidden"> {labelOf(item)}</span>
                    </button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
`;
}

function extraColumnsFor(m: EntityModel, rules: DomainRules): { code: string; imports: string[] } {
  const cols: string[] = [];
  const imports: string[] = [];
  const pr = rules.progress.find((p) => p.entity.name === m.name);
  if (pr) {
    imports.push(`import { progressPercent } from "../lib/domain/progress";`);
    cols.push(`{ label: "Progress", render: (item) => \`\${progressPercent(Number(item.${pr.current.name}), Number(item.${pr.target.name}))}%\` }`);
  }
  const st = rules.streak;
  if (st && st.parent.name === m.name) {
    imports.push(`import { currentStreak, toIsoDate } from "../lib/domain/streak";`);
    cols.push(`{ label: "Streak (days)", render: (item) => currentStreak(${st.entity.pluralCamel}.filter((c) => c.${st.parentField.name} === item.id).map((c) => c.${st.date.name}), toIsoDate(new Date())) }`);
  }
  const pipe = rules.pipeline.find((p) => p.entity.name === m.name);
  if (pipe) {
    const n = pipelineName(pipe);
    const nextFn = `next${n.typeName.slice(m.name.length)}`;
    imports.push(`import { is${n.typeName}, ${nextFn} } from "../lib/domain/${n.module}";`);
    cols.push(`{ label: "Next ${pipe.field.label.toLowerCase()}", render: (item) => { const v = String(item.${pipe.field.name}); return is${n.typeName}(v) ? (${nextFn}(v) ?? "—") : "—"; } }`);
  }
  return { code: cols.length ? `[${cols.join(", ")}]` : "", imports };
}

function appTsx(ctx: GenerateContext, models: EntityModel[], rules: DomainRules, fl: Flavor): string {
  const csv = rules.csv;
  const managed = models.filter((m) => m.name !== csv?.entity.name);
  const needed = new Set<string>();
  for (const m of managed) for (const f of m.fields) if (f.type === "reference" && f.references) needed.add(f.references);
  if (rules.streak) needed.add(rules.streak.entity.name);
  const hooks = models
    .filter((m) => needed.has(m.name))
    .map((m) => `  const ${m.pluralCamel} = useSyncExternalStore(${m.camel}Repository.subscribe, ${m.camel}Repository.list, ${m.camel}Repository.serverList);`)
    .join("\n");
  const imports: string[] = [];
  const sections = managed.map((m) => {
    imports.push(`import { ${m.camel}FormFields, ${m.camel}Fields, ${m.camel}Repository } from "./lib/${m.kebab}";`.replace(/"\.\/lib/, fl === "next" ? '"../lib' : '"./lib'));
    const refs = m.fields.filter((f) => f.type === "reference" && f.references);
    const fieldsExpr = refs.length
      ? `withOptions(${m.camel}FormFields, { ${refs
          .map((f) => {
            const ref = models.find((x) => x.name === f.references);
            return ref ? `${f.name}: ${ref.pluralCamel}.map((r) => ({ value: r.id, label: ${ref.displayField ? `String(r.${ref.displayField} ?? r.id)` : "r.id"} }))` : "";
          })
          .filter(Boolean)
          .join(", ")} })`
      : `${m.camel}FormFields`;
    const extra = extraColumnsFor(m, rules);
    imports.push(...extra.imports.map((i) => (fl === "next" ? i.replace('"../lib', '"../lib') : i.replace('"../lib', '"./lib'))));
    return `          <EntityManager idPrefix=${q(m.kebab)} title=${q(m.labelPlural)} singular=${q(m.label)} fields={${fieldsExpr}} kinds={${m.camel}Fields} repository={${m.camel}Repository}${extra.code ? ` extraColumns={${extra.code}}` : ""} />`;
  });
  const lib = fl === "next" ? "../lib" : "./lib";
  const comp = fl === "next" ? "." : "./components";
  const csvSection = csv ? `          <SalesDashboard />\n` : "";
  const body = `export function ${fl === "next" ? "LocalApp" : "App"}() {
${hooks}
${fl === "vite" ? "  const year = new Date().getFullYear();\n" : ""}  return (
${
  fl === "vite"
    ? `    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <nav className="container" aria-label="Main">
          <a className="brand" href="/">
            {site.name}
          </a>
        </nav>
      </header>
      <main id="main" tabIndex={-1}>
        <div className="container page">
          <h1>{site.name}</h1>
          <p className="lead">${jsxText(ctx.spec.summary.slice(0, 200))}</p>
          <p className="field-hint">Your data is saved in this browser only (localStorage); it is not sent to a server.</p>
${csvSection}${sections.join("\n")}
        </div>
      </main>
      <footer className="site-footer">
        <div className="container">
          <p>
            © {year} {site.name}
          </p>
        </div>
      </footer>
    </>`
    : `    <>
${csvSection}${sections.join("\n")}
    </>`
}
  );
}
`;
  const named = [hooks ? "useSyncExternalStore" : ""].filter(Boolean);
  return `${directive(fl)}${TS_HEADER}
${named.length ? `import { ${named.join(", ")} } from "react";\n` : ""}${sections.length ? `import { EntityManager } from "${comp}/entity-manager";\n` : ""}${csv ? `import { SalesDashboard } from "${comp}/sales-dashboard";\n` : ""}${body.includes("withOptions(") ? `import { withOptions } from "${lib}/form";\n` : ""}${[...new Set(imports)].join("\n")}${imports.length ? "\n" : ""}${fl === "vite" ? `import { site } from "./site";\nimport "./styles/app.css";\n` : ""}
${body}`;
}

// ------------------------------------------------------------------ CSV dashboard

function csvTs(): string {
  return `${TS_HEADER}
/**
 * RFC 4180 CSV parser: quoted fields, escaped quotes (""), commas and newlines inside quotes, CRLF.
 * Returns rows of cells; a trailing newline does not produce an empty row.
 */
export function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\\n" || ch === "\\r") {
      if (ch === "\\r" && src[i + 1] === "\\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Guess the delimiter from the header line (comma, semicolon or tab). */
export function detectDelimiter(text: string): string {
  const header = text.split(/\\r?\\n/, 1)[0] ?? "";
  const counts = [",", ";", "\\t"].map((d) => [d, header.split(d).length - 1] as const);
  return counts.sort((a, b) => b[1] - a[1])[0]?.[0] ?? ",";
}
`;
}

function salesTs(r: CsvRule): string {
  const fields = r.entity.fields;
  const rowSchema = fields
    .map((f) => {
      let e: string;
      if (f.type === "number") e = `z.coerce.number()${f.min !== undefined ? `.min(${f.min})` : ""}`;
      else if (f.type === "integer") e = `z.coerce.number().int()${f.min !== undefined ? `.min(${f.min})` : ""}`;
      else if (f.type === "date" || f.type === "datetime") e = `z.string().trim().regex(/^\\d{4}-\\d{2}-\\d{2}/, "Use YYYY-MM-DD dates")`;
      else if (f.type === "boolean") e = `z.enum(["true", "false", "1", "0", "yes", "no"]).transform((v) => ["true", "1", "yes"].includes(v))`;
      else e = `z.string().trim().min(1, "Required").max(200)`;
      return `  ${f.name}: ${f.required ? e : `${e}.optional()`},`;
    })
    .join("\n");
  const product = r.product?.name;
  return `${TS_HEADER}
import { z } from "zod";
import { detectDelimiter, parseCsv } from "./csv";

/** One ${r.entity.label.toLowerCase()} row of an uploaded CSV (cells are strings; numbers are coerced). */
export const ${r.entity.camel}RowSchema = z.object({
${rowSchema}
});

export type ${r.entity.name} = z.infer<typeof ${r.entity.camel}RowSchema>;

export interface ParseResult {
  records: ${r.entity.name}[];
  errors: Array<{ line: number; message: string }>;
  missingColumns: string[];
}

const COLUMNS: Record<string, string[]> = {
${fields.map((f) => `  ${f.name}: ${JSON.stringify([...new Set([f.name.toLowerCase(), f.column, f.label.toLowerCase()])])},`).join("\n")}
};

const norm = (s: string) => s.trim().toLowerCase().replace(/[\\s-]+/g, "_");

/** Parse and validate an uploaded CSV. Invalid rows are reported with their line number and skipped. */
export function parse${r.entity.pluralPascal}Csv(text: string): ParseResult {
  const rows = parseCsv(text, detectDelimiter(text));
  const header = (rows[0] ?? []).map(norm);
  const index: Record<string, number> = {};
  const missingColumns: string[] = [];
  for (const [field, aliases] of Object.entries(COLUMNS)) {
    const i = header.findIndex((h) => aliases.map(norm).includes(h));
    if (i >= 0) index[field] = i;
    else missingColumns.push(field);
  }
  const required = [${fields.filter((f) => f.required).map((f) => q(f.name)).join(", ")}];
  if (missingColumns.some((c) => required.includes(c))) return { records: [], errors: [], missingColumns };
  const records: ${r.entity.name}[] = [];
  const errors: ParseResult["errors"] = [];
  rows.slice(1).forEach((cells, n) => {
    const raw: Record<string, string | undefined> = {};
    for (const [field, i] of Object.entries(index)) {
      const v = cells[i]?.trim();
      raw[field] = v === "" ? undefined : v;
    }
    const parsed = ${r.entity.camel}RowSchema.safeParse(raw);
    if (parsed.success) records.push(parsed.data);
    else errors.push({ line: n + 2, message: parsed.error.issues.map((i) => \`\${String(i.path[0] ?? "row")}: \${i.message}\`).join("; ") });
  });
  return { records, errors, missingColumns };
}

export interface Point {
  label: string;
  value: number;
}

/** Total ${r.amount.label.toLowerCase()} per calendar month (YYYY-MM), oldest first. */
export function ${r.amount.name}ByMonth(records: readonly ${r.entity.name}[]): Point[] {
  const totals = new Map<string, number>();
  for (const rec of records) {
    const month = rec.${r.date.name}.slice(0, 7);
    totals.set(month, (totals.get(month) ?? 0) + rec.${r.amount.name});
  }
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([label, value]) => ({ label, value: Math.round(value * 100) / 100 }));
}
${
  product
    ? `
/** Products ranked by total ${r.amount.label.toLowerCase()} (highest first). */
export function topProducts(records: readonly ${r.entity.name}[], limit = 5): Point[] {
  const totals = new Map<string, number>();
  for (const rec of records) totals.set(rec.${product}, (totals.get(rec.${product}) ?? 0) + rec.${r.amount.name});
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([label, value]) => ({ label, value: Math.round(value * 100) / 100 }));
}
`
    : ""
}
export function totals(records: readonly ${r.entity.name}[]): { rows: number; ${r.amount.name}: number${r.quantity ? `; ${r.quantity.name}: number` : ""} } {
  return {
    rows: records.length,
    ${r.amount.name}: Math.round(records.reduce((s, x) => s + x.${r.amount.name}, 0) * 100) / 100,${r.quantity ? `\n    ${r.quantity.name}: records.reduce((s, x) => s + (x.${r.quantity.name} ?? 0), 0),` : ""}
  };
}
`;
}

function barChartTsx(fl: Flavor): string {
  return `${directive(fl)}${TS_HEADER}
import { useId } from "react";

export interface BarDatum {
  label: string;
  value: number;
}

/** Accessible horizontal bar chart (SVG with title/description plus a data table for screen readers). */
export function BarChart({ title, data, format = (v) => v.toLocaleString("en-GB") }: { title: string; data: BarDatum[]; format?: (v: number) => string }) {
  const id = useId();
  const max = Math.max(1, ...data.map((d) => d.value));
  const labelWidth = 120;
  const width = 640;
  const row = 28;
  const height = Math.max(row, data.length * row);
  return (
    <figure>
      <figcaption id={\`\${id}-title\`}>
        <strong>{title}</strong>
      </figcaption>
      <svg className="chart" viewBox={\`0 0 \${width} \${height}\`} role="img" aria-labelledby={\`\${id}-title \${id}-desc\`}>
        <desc id={\`\${id}-desc\`}>{data.map((d) => \`\${d.label}: \${format(d.value)}\`).join(", ")}</desc>
        {data.map((d, i) => {
          const w = Math.max(2, ((width - labelWidth - 90) * d.value) / max);
          return (
            <g key={d.label} transform={\`translate(0 \${i * row})\`}>
              <text className="chart-label" x={0} y={row / 2 + 4}>
                {d.label}
              </text>
              <rect className="chart-bar" x={labelWidth} y={4} width={w} height={row - 8} rx={3} />
              <text className="chart-label" x={labelWidth + w + 6} y={row / 2 + 4}>
                {format(d.value)}
              </text>
            </g>
          );
        })}
      </svg>
      <table className="visually-hidden">
        <caption>{title}</caption>
        <tbody>
          {data.map((d) => (
            <tr key={d.label}>
              <th scope="row">{d.label}</th>
              <td>{format(d.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
`;
}

function dashboardTsx(r: CsvRule, fl: Flavor): string {
  const P = r.entity.pluralPascal;
  const lib = "../lib";
  return `${directive(fl)}${TS_HEADER}
import { useState, type ChangeEvent } from "react";
import { BarChart } from "./bar-chart";
import { ${r.amount.name}ByMonth, parse${P}Csv, ${r.product ? "topProducts, " : ""}totals, type ParseResult } from "${lib}/${r.entity.kebab}-csv";

const money = (v: number) => v.toLocaleString("en-GB", { maximumFractionDigits: 2 });

/** Upload a CSV, validate it and chart ${r.amount.label.toLowerCase()} per month${r.product ? " and the top products" : ""}. */
export function SalesDashboard({ initialCsv }: { initialCsv?: string }) {
  const [result, setResult] = useState<ParseResult | null>(() => (initialCsv ? parse${P}Csv(initialCsv) : null));
  const [source, setSource] = useState<string>(initialCsv ? "provided data" : "");
  const [error, setError] = useState("");

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.currentTarget.files?.[0];
    if (!file) return;
    if (file.size > 5_000_000) {
      setError("That file is larger than 5 MB.");
      return;
    }
    setError("");
    setResult(parse${P}Csv(await file.text()));
    setSource(file.name);
  }

  async function loadSample() {
    setError("");
    try {
      const res = await fetch("/sample-sales.csv");
      if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
      setResult(parse${P}Csv(await res.text()));
      setSource("sample data (fictional)");
    } catch (err) {
      setError(\`Could not load the sample: \${(err as Error).message}\`);
    }
  }

  const records = result?.records ?? [];
  const sum = totals(records);
  return (
    <section className="card" aria-labelledby="dashboard-title">
      <h2 id="dashboard-title">${jsxText(r.entity.labelPlural)} dashboard</h2>
      <div className="field">
        <label htmlFor="csv-file">Upload a CSV file</label>
        <input id="csv-file" type="file" accept=".csv,text/csv" onChange={onFile} aria-describedby="csv-help" />
        <p id="csv-help" className="field-hint">
          Columns: ${r.entity.fields.map((f) => jsxText(f.column)).join(", ")}. Files are read in your browser and never uploaded.
        </p>
      </div>
      <p>
        <button className="button" data-variant="ghost" type="button" onClick={loadSample}>
          Load sample data (fictional)
        </button>
      </p>
      <p role="status" aria-live="polite" className={error ? "form-status-error" : undefined}>
        {error || (result ? \`Loaded \${sum.rows} rows from \${source}.\` : "No data loaded yet.")}
      </p>
      {result && result.missingColumns.length > 0 ? <p className="form-status-error">Missing columns: {result.missingColumns.join(", ")}</p> : null}
      {result && result.errors.length > 0 ? (
        <details>
          <summary>{result.errors.length} row(s) skipped</summary>
          <ul>
            {result.errors.slice(0, 20).map((e) => (
              <li key={e.line}>
                Line {e.line}: {e.message}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {records.length > 0 ? (
        <>
          <p>
            Total ${jsxText(r.amount.label.toLowerCase())}: <strong>{money(sum.${r.amount.name})}</strong>${r.quantity ? ` · ${jsxText(r.quantity.label)}: <strong>{sum.${r.quantity.name}.toLocaleString("en-GB")}</strong>` : ""}
          </p>
          <BarChart title="${jsxText(r.amount.label)} per month" data={${r.amount.name}ByMonth(records)} format={money} />
${r.product ? `          <BarChart title="Top products by ${jsxText(r.amount.label.toLowerCase())}" data={topProducts(records)} format={money} />\n` : ""}        </>
      ) : null}
    </section>
  );
}
`;
}

/** Deterministic, clearly fictional sample file for demos and evals. */
export function sampleSalesCsv(r: CsvRule): string {
  const products = ["Espresso beans", "Filter coffee", "Tea sampler", "Ceramic mug", "Cold brew kit"];
  const prices = [129, 89, 149, 199, 249];
  const header = r.entity.fields.map((f) => f.column);
  const lines = [header.join(",")];
  for (let m = 1; m <= 12; m++) {
    for (let p = 0; p < products.length; p++) {
      const qty = ((m * 7 + p * 13) % 20) + 3;
      const row = r.entity.fields.map((f) => {
        if (f.name === r.date.name) return `2025-${String(m).padStart(2, "0")}-${String(((p * 5) % 27) + 1).padStart(2, "0")}`;
        if (f.name === r.amount.name) return String(qty * (prices[p] ?? 100));
        if (f.name === r.product?.name) return products[p] ?? "Product";
        if (f.name === r.quantity?.name) return String(qty);
        if (f.type === "number" || f.type === "integer") return String(qty);
        if (f.type === "boolean") return "true";
        return `sample-${p + 1}`;
      });
      lines.push(row.join(","));
    }
  }
  return `${lines.join("\n")}\n`;
}

function csvTests(r: CsvRule, imp: (m: string) => string): string {
  const P = r.entity.pluralPascal;
  const header = r.entity.fields.map((f) => f.column).join(",");
  const rowFor = (amount: number, month: string, product: string) =>
    r.entity.fields
      .map((f) => (f.name === r.date.name ? `2026-${month}-05` : f.name === r.amount.name ? String(amount) : f.name === r.product?.name ? product : f.type === "number" || f.type === "integer" ? "2" : f.type === "boolean" ? "true" : "x"))
      .join(",");
  return `${TS_HEADER}
import { describe, expect, it } from "vitest";
import { detectDelimiter, parseCsv } from ${q(imp("csv"))};
import { ${r.amount.name}ByMonth, parse${P}Csv, ${r.product ? "topProducts, " : ""}totals } from ${q(imp(`${r.entity.kebab}-csv`))};

describe("csv parser", () => {
  it("handles quotes, escaped quotes, embedded newlines and CRLF", () => {
    expect(parseCsv('a,b\\r\\n"x, y","say ""hi"""\\n"multi\\nline",2\\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["multi\\nline", "2"],
    ]);
  });

  it("detects semicolon files", () => {
    expect(detectDelimiter("date;product;revenue\\n")).toBe(";");
  });
});

describe("${r.entity.labelPlural.toLowerCase()} csv", () => {
  const csv = [${q(header)}, ${q(rowFor(100, "01", "Alpha"))}, ${q(rowFor(50, "01", "Beta"))}, ${q(rowFor(25.5, "02", "Alpha"))}].join("\\n");

  it("parses valid rows and aggregates per month", () => {
    const r = parse${P}Csv(csv);
    expect(r.errors).toEqual([]);
    expect(r.records).toHaveLength(3);
    expect(${r.amount.name}ByMonth(r.records)).toEqual([
      { label: "2026-01", value: 150 },
      { label: "2026-02", value: 25.5 },
    ]);
    expect(totals(r.records).${r.amount.name}).toBe(175.5);
  });
${
  r.product
    ? `
  it("ranks top products", () => {
    expect(topProducts(parse${P}Csv(csv).records)[0]).toEqual({ label: "Alpha", value: 125.5 });
  });
`
    : ""
}
  it("reports invalid rows with line numbers and missing columns", () => {
    const bad = parse${P}Csv([${q(header)}, ${q(rowFor(100, "01", "Alpha").replace("2026-01-05", "yesterday"))}].join("\\n"));
    expect(bad.records).toHaveLength(0);
    expect(bad.errors[0]?.line).toBe(2);
    expect(parse${P}Csv("foo,bar\\n1,2").missingColumns).toContain(${q(r.amount.name)});
  });
});
`;
}

// ------------------------------------------------------------------ tests

export function entityTests(models: EntityModel[], imp: (m: string) => string): string {
  const blocks = models.map((m) => {
    const sample = `{ ${m.fields.map((f) => `${f.name}: ${sampleFor(f, "form")}`).join(", ")} }`;
    const bad = m.fields
      .map((f) => ({ f, v: invalidFor(f) }))
      .filter((x) => x.v !== null)
      .slice(0, 3)
      .map(({ f, v }) => `    expect(repo.create({ ...valid, ${f.name}: ${v} }).ok).toBe(false);`)
      .join("\n");
    return `describe("${m.label.toLowerCase()} repository", () => {
  const valid = ${sample};

  it("creates, lists, updates and removes ${m.labelPlural.toLowerCase()} (validated)", () => {
    const repo = createRepository(${q(`test.${m.pluralKebab}`)}, ${m.camel}Schema, memoryStore());
    const created = repo.create(valid);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(repo.list()).toHaveLength(1);
    expect(repo.update(created.value.id, valid).ok).toBe(true);
${bad}
    expect(repo.remove(created.value.id)).toBe(true);
    expect(repo.list()).toEqual([]);
  });

  it("drops corrupt stored rows instead of crashing", () => {
    const store = memoryStore();
    store.setItem("k", JSON.stringify([{ id: "1", nope: true }, "x"]));
    expect(createRepository("k", ${m.camel}Schema, store).list()).toEqual([]);
  });
});
`;
  });
  return `${TS_HEADER}
import { describe, expect, it } from "vitest";
import { createRepository } from ${q(imp("repository"))};
import { memoryStore } from ${q(imp("storage"))};
${models.map((m) => `import { ${m.camel}Schema } from ${q(imp(m.kebab))};`).join("\n")}

${blocks.join("\n")}`;
}

function viteAppTest(models: EntityModel[], rules: DomainRules): string {
  const m = models.find((x) => x.name !== rules.csv?.entity.name && !x.fields.some((f) => f.type === "reference"));
  const req = m?.fields.find((f) => f.required && (f.type === "string" || f.type === "email"));
  const csv = rules.csv;
  return `${TS_HEADER}
import { beforeEach, describe, expect, it } from "vitest";
import { ${m && req ? "fireEvent, " : ""}render, screen${csv ? ", within" : ""} } from "@testing-library/react";
import { App } from "../src/App";
${csv ? `import { SalesDashboard } from "../src/components/sales-dashboard";\nimport { sampleCsv } from "./fixtures";\n` : ""}
beforeEach(() => localStorage.clear());

describe("App", () => {
  it("renders landmarks and the main heading", () => {
    render(<App />);
    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByRole("contentinfo")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBeTruthy();
    expect(screen.getByRole("link", { name: "Skip to content" }).getAttribute("href")).toBe("#main");
  });
${
  m && req
    ? `
  it("shows a validation error and saves nothing when ${req.label.toLowerCase()} is empty", () => {
    render(<App />);
    const form = screen.getByRole("form", { name: ${q(`New ${m.label.toLowerCase()}`)} });
    fireEvent.submit(form);
    expect(screen.getAllByText("Please fix the highlighted fields.").length).toBeGreaterThan(0);
    expect(localStorage.getItem(${q(`forge.${m.pluralKebab}`)})).toBeNull();
  });

  it("adds a ${m.label.toLowerCase()} and keeps it after a reload", () => {
    const first = render(<App />);
    const form = screen.getByRole("form", { name: ${q(`New ${m.label.toLowerCase()}`)} });
${m.fields
  .filter((f) => f.required && f.type !== "boolean")
  .map((f) => `    fireEvent.change(screen.getByLabelText(${`/^${f.label.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/`}, { selector: ${q(`#${m.kebab}-field-${f.name}`)} }), { target: { value: ${f.type === "enum" ? q(f.enumValues[0] ?? "") : sampleFor(f, "form").replace(/^(\d+)$/, '"$1"')} } });`)
  .join("\n")}
    fireEvent.submit(form);
    expect(screen.getByText(${q(`${m.label} added.`)})).toBeTruthy();
    first.unmount();
    render(<App />);
    expect(screen.getAllByText(${sampleFor(req, "form")}).length).toBeGreaterThan(0);
  });
`
    : ""
}});
${
  csv
    ? `
describe("SalesDashboard", () => {
  it("charts uploaded data", () => {
    render(<SalesDashboard initialCsv={sampleCsv} />);
    const charts = screen.getAllByRole("img");
    expect(charts.length).toBeGreaterThanOrEqual(1);
    expect(within(charts[0]!).getAllByText(/2025-01/).length).toBeGreaterThan(0);
    expect(screen.getByRole("status").textContent).toMatch(/Loaded \\d+ rows/);
  });
});
`
    : ""
}`;
}

export function generateWebLocal(ctx: GenerateContext, fl: Flavor): GeneratedProject {
  const out = emptyProject(fl === "vite" ? "vite-local" : "nextjs-local");
  const models = entityModels(ctx.spec);
  const rules = detectRules(ctx.spec, models);
  const f = out.files;
  const csv = rules.csv;
  const crud = models.filter((m) => m.name !== csv?.entity.name);
  if (crud.length) {
    f["src/lib/form.ts"] = formLibTs();
    f["src/lib/storage.ts"] = storageTs();
    f["src/lib/repository.ts"] = repositoryTs();
    f["src/components/field-control.tsx"] = fieldControlTsx();
    f["src/components/entity-manager.tsx"] = managerTsx(fl);
  }
  for (const m of crud) f[`src/lib/${m.kebab}.ts`] = entityTs(m, models);
  const imp = fl === "vite" ? (mod: string) => `../src/lib/${mod}` : (mod: string) => `@/lib/${mod}`;
  if (crud.length) f["test/entities.test.ts"] = entityTests(crud, imp);
  if (csv) {
    f["src/lib/csv.ts"] = csvTs();
    f[`src/lib/${csv.entity.kebab}-csv.ts`] = salesTs(csv);
    f["src/components/bar-chart.tsx"] = barChartTsx(fl);
    f["src/components/sales-dashboard.tsx"] = dashboardTsx(csv, fl);
    f["public/sample-sales.csv"] = sampleSalesCsv(csv);
    f["test/csv.test.ts"] = csvTests(csv, imp);
    if (fl === "vite") f["test/fixtures.ts"] = `${TS_HEADER}\n// Small slice of public/sample-sales.csv (fictional sample data).\nexport const sampleCsv = ${q(sampleSalesCsv(csv).split("\n").slice(0, 11).join("\n"))};\n`;
    out.notes.push("public/sample-sales.csv is generated, clearly fictional sample data (the dashboard labels it as such); uploaded CSV files are parsed in the browser and never sent to a server.");
  }
  for (const p of rules.pipeline) {
    const n = pipelineName(p);
    f[`src/lib/domain/${n.module}.ts`] = pipelineTs(p);
    f[`test/${n.module}.test.ts`] = pipelineTest(p, imp(`domain/${n.module}`));
  }
  if (rules.progress.length) {
    f["src/lib/domain/progress.ts"] = progressTs();
    f["test/progress.test.ts"] = progressTest(imp("domain/progress"));
  }
  if (rules.streak) {
    f["src/lib/domain/streak.ts"] = streakTs();
    f["test/streak.test.ts"] = streakTest(imp("domain/streak"));
  }
  f["src/styles/app.css"] = appCss();
  if (fl === "vite") {
    f["src/App.tsx"] = appTsx(ctx, models, rules, fl);
    f["test/app.test.tsx"] = viteAppTest(models, rules);
  } else {
    f["src/components/local-app.tsx"] = appTsx(ctx, models, rules, fl);
    const integration = ctx.openapi ? generateIntegration(ctx.openapi.api, { auth: false }) : undefined;
    if (integration) {
      Object.assign(f, integration.files);
      out.setup.push(...integration.setup);
      out.notes.push(...integration.notes);
    }
    f["src/app/page.tsx"] = nextLocalPage(ctx, integration?.explorer);
    f["src/app/api/health/route.ts"] = healthRoute();
  }
  if (fl === "vite" && ctx.openapi) out.notes.push(`The OpenAPI document (${ctx.openapi.api.title}) was not wired in: a Vite app has no server to keep the API key secret. Use the nextjs template for API integrations.`);
  out.setup.push(`npm install --no-audit --no-fund zod@${ZOD_VERSION}`);
  out.verify.push("npm run typecheck", "npm run lint");
  out.autofix = "npx eslint . --fix";
  out.notes.push(`Data is stored in the browser with a localStorage adapter (src/lib/storage.ts): it stays on one device and is not shared between users${ctx.spec.auth ? "" : " (the spec has no accounts)"}.`);
  return out;
}

function nextLocalPage(ctx: GenerateContext, explorer?: { importLine: string; jsx: string }): string {
  return `${TS_HEADER}
${explorer ? `${explorer.importLine}\n` : ""}import { LocalApp } from "@/components/local-app";
import { site } from "@/lib/site";
import "@/styles/app.css";

export default function HomePage() {
  return (
    <div className="container page">
      <h1>{site.name}</h1>
      <p className="lead">${jsxText(ctx.spec.summary.slice(0, 200))}</p>
${explorer ? `      ${explorer.jsx}\n` : ""}      <p className="field-hint">Your data is saved in this browser only (localStorage); it is not sent to a server.</p>
      <LocalApp />
    </div>
  );
}
`;
}
