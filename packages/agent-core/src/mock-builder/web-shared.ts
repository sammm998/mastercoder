import type { EntityModel, FieldModel } from "./model.js";
import { htmlInputType } from "./model.js";
import { TS_HEADER, q } from "./names.js";

/** Source shared by the React generators (Next.js and Vite): form helpers, field descriptors, styles. */

export function formLibTs(): string {
  return `${TS_HEADER}
/** How a form field is read from submitted FormData before schema validation. */
export type FieldKind = "text" | "number" | "boolean";

/** Serializable description of one form field (rendered by the generic entity form). */
export interface FieldDescriptor {
  name: string;
  label: string;
  input: "text" | "textarea" | "email" | "url" | "number" | "date" | "datetime-local" | "checkbox" | "select";
  required?: boolean;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: string;
  maxLength?: number;
  hint?: string;
}

export interface FormState {
  ok: boolean;
  message?: string;
  errors?: Record<string, string[]>;
}

export const initialFormState: FormState = { ok: false };

/** Typed values from FormData: blank → missing, checkbox → boolean, numeric inputs → number. */
export function formValues(formData: FormData, kinds: Record<string, FieldKind>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, kind] of Object.entries(kinds)) {
    const raw = formData.get(name);
    if (kind === "boolean") {
      out[name] = raw === "on" || raw === "true";
      continue;
    }
    if (typeof raw !== "string" || raw.trim() === "") continue;
    out[name] = kind === "number" ? Number(raw) : raw.trim();
  }
  return out;
}

/** Zod issues → { field: [messages] } for inline errors. */
export function fieldErrors(issues: readonly { path: readonly PropertyKey[]; message: string }[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = issue.path.length ? String(issue.path[0]) : "form";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

/** Attach select options (loaded at request time) to reference fields. */
export function withOptions(fields: readonly FieldDescriptor[], options: Record<string, readonly { value: string; label: string | null }[]>): FieldDescriptor[] {
  return fields.map((f) => {
    const opts = options[f.name];
    return opts ? { ...f, options: opts.map((o) => ({ value: o.value, label: o.label ?? o.value })) } : f;
  });
}
`;
}

export function fieldKindsLiteral(m: EntityModel): string {
  return `{ ${m.fields.map((f) => `${f.name}: ${q(f.kind)}`).join(", ")} }`;
}

function descriptor(f: FieldModel, models: EntityModel[]): string {
  const parts: string[] = [`name: ${q(f.name)}`, `label: ${q(f.label)}`];
  let input = htmlInputType(f);
  if (f.type === "text") input = "textarea";
  if (f.type === "enum" || f.type === "reference") input = "select";
  parts.push(`input: ${q(input)}`);
  if (f.required && f.type !== "boolean") parts.push("required: true");
  if (f.type === "enum") parts.push(`options: [${f.enumValues.map((v) => `{ value: ${q(v)}, label: ${q(v.charAt(0).toUpperCase() + v.slice(1))} }`).join(", ")}]`);
  if (f.type === "reference") parts.push("options: []");
  if (f.min !== undefined) parts.push(`min: ${f.min}`);
  if (f.max !== undefined) parts.push(`max: ${f.max}`);
  if (f.type === "number") parts.push(`step: "any"`);
  if (f.type === "integer") parts.push(`step: "1"`);
  if (["string", "text", "email", "url"].includes(f.type)) parts.push(`maxLength: ${f.maxLength}`);
  if (f.pattern) parts.push(`hint: ${q(f.pattern.message)}`);
  if (f.type === "reference") {
    const ref = models.find((m) => m.name === f.references);
    if (ref) parts.push(`hint: ${q(`Add ${ref.labelPlural.toLowerCase()} first if the list is empty.`)}`);
  }
  return `{ ${parts.join(", ")} }`;
}

export function fieldDescriptorsLiteral(m: EntityModel, models: EntityModel[]): string {
  return `[\n${m.fields.map((f) => `  ${descriptor(f, models)},`).join("\n")}\n]`;
}

/** Generic, accessible form renderer used by both frameworks. `clientDirective` for Next.js. */
export function fieldControlTsx(): string {
  return `${TS_HEADER}
import type { ReactNode } from "react";
import type { FieldDescriptor } from "../lib/form";

/** One labelled form control with hint and inline error (aria-describedby / aria-invalid). */
export function FieldControl({ field, id, error, defaultValue }: { field: FieldDescriptor; id: string; error?: string; defaultValue?: string | boolean }) {
  const describedBy = [field.hint ? \`\${id}-hint\` : null, error ? \`\${id}-error\` : null].filter(Boolean).join(" ") || undefined;
  const common = { id, name: field.name, required: field.required, "aria-invalid": error ? true : undefined, "aria-describedby": describedBy } as const;
  const text = typeof defaultValue === "string" ? defaultValue : "";
  let control: ReactNode;
  if (field.input === "checkbox") {
    control = <input {...common} type="checkbox" defaultChecked={defaultValue === true} />;
  } else if (field.input === "textarea") {
    control = <textarea {...common} rows={4} maxLength={field.maxLength} defaultValue={text} />;
  } else if (field.input === "select") {
    control = (
      <select {...common} defaultValue={text}>
        <option value="">Choose…</option>
        {(field.options ?? []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else {
    control = <input {...common} type={field.input} min={field.min} max={field.max} step={field.step} maxLength={field.maxLength} defaultValue={text} />;
  }
  return (
    <div className={field.input === "checkbox" ? "field field-checkbox" : "field"}>
      <label htmlFor={id}>
        {field.label}
        {field.required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {control}
      {field.hint ? (
        <p id={\`\${id}-hint\`} className="field-hint">
          {field.hint}
        </p>
      ) : null}
      {error ? (
        <p id={\`\${id}-error\`} className="field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
`;
}

export function appCss(): string {
  return `/* ${"Generated by Forge mock builder (rule-based, offline)"}. Uses the design tokens from tokens.css. */
.page {
  padding-block: var(--space-12);
}

.page-nav ul,
.link-grid {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  list-style: none;
  padding: 0;
  margin: 0 0 var(--space-8);
}

.card {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  padding: var(--space-6);
  margin-block-end: var(--space-8);
}

.field select,
.field input,
.field textarea {
  font: inherit;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text);
}

.field-checkbox {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.field-hint {
  margin: 0;
  color: var(--color-muted);
  font-size: 0.9rem;
}

.field-error,
.form-status-error {
  margin: 0;
  color: var(--color-accent);
  font-weight: 600;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
}

.data-table th,
.data-table td {
  text-align: left;
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-border);
  vertical-align: top;
}

.row-actions {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}

.row-actions form {
  margin: 0;
}

.board {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  gap: var(--space-4);
}

.board ul {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: var(--space-3);
}

.chart {
  width: 100%;
  height: auto;
  max-width: 48rem;
}

.chart-bar {
  fill: var(--color-accent);
}

.chart-label {
  fill: var(--color-text);
  font-size: 12px;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
`;
}

/** Next.js liveness route, explicitly public (no data). */
export function healthRoute(): string {
  return `// forge:public — liveness probe for the Forge deployer and the Docker HEALTHCHECK (no data, no auth needed).
${TS_HEADER}
export const dynamic = "force-dynamic";

/** Liveness probe used by the Forge deployer and the Docker HEALTHCHECK. */
export function GET() {
  return Response.json({ status: "ok", uptimeSec: Math.round(process.uptime()) });
}
`;
}
