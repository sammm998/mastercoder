import type { EntityModel, FieldModel } from "./model.js";
import { entityModels, invalidFor, sampleFor, zodFor } from "./model.js";
import { bookingRulesTest, bookingRulesTs, detectRules, pipelineName, pipelineTest, pipelineTs, progressTest, progressTs, type DomainRules, type PipelineRule } from "./domain.js";
import { SQL_HEADER, TS_HEADER, camel, importLine, jsxText, pascal, q } from "./names.js";
import { appCss, fieldControlTsx, fieldDescriptorsLiteral, fieldKindsLiteral, formLibTs, healthRoute } from "./web-shared.js";
import { emptyProject, type GenerateContext, type GeneratedProject } from "./types.js";
import { generateIntegration } from "./gen-openapi.js";

/**
 * Next.js (App Router) + app-kit auth/db generator: Drizzle tables with owner columns and RLS
 * policies (pgPolicy → drizzle-kit migration), zod validation, server actions guarded by
 * requireUser() and run inside withUser() so Postgres row-level security applies.
 */

export const ZOD_VERSION = "^4.6.7";

function drizzleColumn(f: FieldModel, models: EntityModel[]): string {
  const c = q(f.column);
  let e: string;
  switch (f.type) {
    case "string":
    case "text":
    case "email":
    case "url":
      e = `text(${c})`;
      break;
    case "enum":
      e = `text(${c}, { enum: [${f.enumValues.map(q).join(", ")}] })`;
      break;
    case "number":
      e = `doublePrecision(${c})`;
      break;
    case "integer":
      e = `integer(${c})`;
      break;
    case "boolean":
      e = `boolean(${c}).default(false)`;
      break;
    case "date":
      e = `date(${c}, { mode: "string" })`;
      break;
    case "datetime":
      e = `timestamp(${c}, { withTimezone: true })`;
      break;
    case "reference": {
      const ref = models.find((m) => m.name === f.references);
      e = ref ? `uuid(${c}).references(() => ${ref.pluralCamel}.id, { onDelete: "cascade" })` : `text(${c})`;
      break;
    }
  }
  return f.required ? `${e}.notNull()` : e;
}

function tableTs(m: EntityModel, models: EntityModel[], rules: DomainRules): string {
  const cols = [`    id: uuid("id").primaryKey().defaultRandom(),`, `    ownerId: text("owner_id").notNull().references(() => user.id, { onDelete: "cascade" }),`];
  for (const f of m.fields) cols.push(`    ${f.name}: ${drizzleColumn(f, models)},`);
  const booking = rules.booking?.entity.name === m.name ? rules.booking : undefined;
  if (booking) cols.push(`    /** Computed from the start and the service duration; used by the no-overlap constraint. */\n    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),`);
  cols.push(`    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),`, `    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),`);
  const extra: string[] = [`    index(${q(`${m.table}_owner_idx`)}).on(t.ownerId),`];
  for (const f of m.fields) if (f.type === "enum") extra.push(`    check(${q(`${m.table}_${f.column}_check`)}, sql\`${f.column} in (${f.enumValues.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ")})\`),`);
  if (booking) extra.push(`    /** One booking per ${booking.resource.label.toLowerCase()} and start time (overlaps are rejected by the exclusion constraint in the booking_rules migration). */\n    uniqueIndex(${q(`${m.table}_${booking.resource.column}_slot_uq`)}).on(t.${booking.resource.name}, t.${booking.start.name}),`);
  if (m.ownerScoped) {
    extra.push(`    pgPolicy(${q(`${m.table}_owner_all`)}, { for: "all", using: isOwner, withCheck: isOwner }),`);
  } else {
    extra.push(
      `    pgPolicy(${q(`${m.table}_read_signed_in`)}, { for: "select", using: signedIn }),`,
      `    pgPolicy(${q(`${m.table}_owner_insert`)}, { for: "insert", withCheck: isOwner }),`,
      `    pgPolicy(${q(`${m.table}_owner_update`)}, { for: "update", using: isOwner, withCheck: isOwner }),`,
      `    pgPolicy(${q(`${m.table}_owner_delete`)}, { for: "delete", using: isOwner }),`,
    );
  }
  const doc = m.ownerScoped
    ? `/** ${m.labelPlural}: rows are private to their owner (RLS owner policy). */`
    : `/** ${m.labelPlural}: readable by every signed-in user, changed only by the user who created them (RLS). */`;
  return `${doc}\nexport const ${m.pluralCamel} = pgTable(\n  ${q(m.table)},\n  {\n${cols.join("\n")}\n  },\n  (t) => [\n${extra.join("\n")}\n  ],\n);\n\nexport type ${m.name} = typeof ${m.pluralCamel}.$inferSelect;\n`;
}

function schemaTs(models: EntityModel[], rules: DomainRules): string {
  const tables = models.map((m) => tableTs(m, models, rules)).join("\n");
  const body = `${tables}
/*
 * Better Auth tables (src/db/auth-schema.ts) also get RLS. Better Auth itself runs without a user
 * context (forge_current_user_id() is null) and keeps full access; inside withUser() a request can only
 * see its own user, session and account rows.
 */
export const userSelfPolicy = pgPolicy("user_self", { for: "all", using: sql\`forge_current_user_id() is null or id = forge_current_user_id()\` }).link(user);
export const sessionSelfPolicy = pgPolicy("session_self", { for: "all", using: sql\`forge_current_user_id() is null or user_id = forge_current_user_id()\` }).link(session);
export const accountSelfPolicy = pgPolicy("account_self", { for: "all", using: sql\`forge_current_user_id() is null or user_id = forge_current_user_id()\` }).link(account);
export const verificationServerPolicy = pgPolicy("verification_server", { for: "all", using: sql\`forge_current_user_id() is null\` }).link(verification);
`;
  const pg = ["boolean", "check", "date", "doublePrecision", "index", "integer", "pgPolicy", "pgTable", "text", "timestamp", "uniqueIndex", "uuid"];
  return `${TS_HEADER}
// App tables. Row-level security policies are declared here; \`npm run db:generate\` turns them into SQL.
${importLine(["sql"], "drizzle-orm", body)}${importLine(pg, "drizzle-orm/pg-core", body)}import { account, session, user, verification } from "./auth-schema";

/** forge_current_user_id() is set per transaction by withUser() (see drizzle/0000_forge_rls.sql). */
const isOwner = sql\`owner_id = forge_current_user_id()\`;
${models.some((m) => !m.ownerScoped) ? "const signedIn = sql`forge_current_user_id() is not null`;\n" : ""}
${body}`;
}

function validationTs(m: EntityModel, models: EntityModel[]): string {
  const refLabel = (f: FieldModel) => models.find((x) => x.name === f.references)?.label;
  return `${TS_HEADER}
import { z } from "zod";
import type { FieldDescriptor, FieldKind } from "@/lib/form";

/** How each ${m.label.toLowerCase()} form field is read from FormData. */
export const ${m.camel}Fields = ${fieldKindsLiteral(m)} as const satisfies Record<string, FieldKind>;

/** Validation for creating and updating ${m.labelPlural.toLowerCase()} (server actions). */
export const ${m.camel}Schema = z.object({
${m.fields.map((f) => `  ${f.name}: ${zodFor(f, "form", refLabel(f))},`).join("\n")}
});

export type ${m.name}Input = z.infer<typeof ${m.camel}Schema>;

export const ${m.camel}IdSchema = z.object({ id: z.string().uuid() });

/** Form controls (reference options are filled in at request time). */
export const ${m.camel}FormFields: FieldDescriptor[] = ${fieldDescriptorsLiteral(m, models)};
`;
}

function rowFn(m: EntityModel): string {
  const opt = m.fields.filter((f) => !f.required);
  if (!opt.length) return `function toRow(input: ${m.name}Input) {\n  return input;\n}`;
  return `/** Optional fields left blank are stored as NULL (so clearing a field on edit works). */\nfunction toRow(input: ${m.name}Input) {\n  return { ...input, ${opt.map((f) => `${f.name}: input.${f.name} ?? null`).join(", ")} };\n}`;
}

function actionsTs(m: EntityModel, rules: DomainRules): string {
  const booking = rules.booking?.entity.name === m.name ? rules.booking : undefined;
  const pipelines = rules.pipeline.filter((p) => p.entity.name === m.name);
  const t = m.pluralCamel;
  const invalid = `{ ok: false, message: "Please fix the highlighted fields.", errors: fieldErrors(parsed.error.issues) }`;
  let save: string;
  if (booking) {
    const d = booking.duration;
    const durationExpr = d
      ? `const [ref] = await tx.select({ minutes: ${d.entity.pluralCamel}.${d.durationField.name} }).from(${d.entity.pluralCamel}).where(eq(${d.entity.pluralCamel}.id, input.${d.field.name})).limit(1);
    if (!ref) return { ok: false, message: "Choose a ${d.entity.label.toLowerCase()}.", errors: { ${d.field.name}: ["Unknown ${d.entity.label.toLowerCase()}"] } };
    const endsAt = bookingEnd(input.${booking.start.name}, ref.minutes);`
      : `const endsAt = bookingEnd(input.${booking.start.name}, SLOT_MINUTES);`;
    save = `const TAKEN: FormState = { ok: false, message: "That time is already booked. Pick another time or ${booking.resource.label.toLowerCase()}.", errors: { ${booking.start.name}: ["Already booked"] } };

/**
 * Saves a ${m.label.toLowerCase()} after the booking rules: start on the slot grid and no overlap for the same
 * ${booking.resource.label.toLowerCase()}. The check below only sees the user's own rows (RLS); bookings of other users are
 * rejected by the database (unique index + exclusion constraint), which is caught as a conflict.
 */
async function save${m.name}(userId: string, input: ${m.name}Input, id?: string): Promise<FormState> {
  if (!isOnSlotGrid(input.${booking.start.name})) {
    return { ok: false, message: \`Pick a start time on a \${SLOT_MINUTES}-minute boundary.\`, errors: { ${booking.start.name}: ["Not on the slot grid"] } };
  }
  try {
    return await withUser(db, userId, async (tx): Promise<FormState> => {
    ${durationExpr}
    const mine = await tx
      .select({ id: ${t}.id, resourceId: ${t}.${booking.resource.name}, start: ${t}.${booking.start.name}, end: ${t}.endsAt })
      .from(${t})
      .where(eq(${t}.${booking.resource.name}, input.${booking.resource.name}));
    if (findConflict(mine.filter((b) => b.id !== id), { resourceId: input.${booking.resource.name}, start: input.${booking.start.name}, end: endsAt })) return TAKEN;
    if (id) {
      const rows = await tx.update(${t}).set({ ...toRow(input), endsAt, updatedAt: new Date() }).where(and(eq(${t}.id, id), eq(${t}.ownerId, userId))).returning({ id: ${t}.id });
      return rows.length ? { ok: true, message: "${m.label} updated." } : { ok: false, message: "${m.label} not found." };
    }
    await tx.insert(${t}).values({ ...toRow(input), endsAt, ownerId: userId });
    return { ok: true, message: "${m.label} saved." };
    });
  } catch (error) {
    if (isConflictError(error)) return TAKEN;
    throw error;
  }
}
`;
  } else {
    save = `async function save${m.name}(userId: string, input: ${m.name}Input, id?: string): Promise<FormState> {
  return withUser(db, userId, async (tx): Promise<FormState> => {
    if (id) {
      const rows = await tx.update(${t}).set({ ...toRow(input), updatedAt: new Date() }).where(and(eq(${t}.id, id), eq(${t}.ownerId, userId))).returning({ id: ${t}.id });
      return rows.length ? { ok: true, message: "${m.label} updated." } : { ok: false, message: "${m.label} not found." };
    }
    await tx.insert(${t}).values({ ...toRow(input), ownerId: userId });
    return { ok: true, message: "${m.label} saved." };
  });
}
`;
  }
  const moves = pipelines
    .map((p) => {
      const n = pipelineName(p);
      const F = pascal(p.field.name);
      return `
/** Move a ${m.label.toLowerCase()} one ${p.field.label.toLowerCase()} forward or back in the pipeline. */
export async function move${m.name}${F}(formData: FormData): Promise<void> {
  const user = await requireUser(${q(m.route)});
  const parsed = z.object({ id: z.string().uuid(), direction: z.enum(["next", "previous"]) }).safeParse({ id: formData.get("id"), direction: formData.get("direction") });
  if (!parsed.success) return;
  const { id, direction } = parsed.data;
  await withUser(db, user.id, async (tx) => {
    const [row] = await tx.select({ value: ${t}.${p.field.name} }).from(${t}).where(eq(${t}.id, id)).limit(1);
    if (!row || !is${n.typeName}(row.value)) return;
    const target = direction === "next" ? next${F}(row.value) : previous${F}(row.value);
    if (target) await tx.update(${t}).set({ ${p.field.name}: target, updatedAt: new Date() }).where(and(eq(${t}.id, id), eq(${t}.ownerId, user.id)));
  });
  revalidatePath(${q(m.route)});
}
`;
    })
    .join("");
  const body = `${rowFn(m)}

${save}
export async function create${m.name}(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser(${q(m.route)});
  const parsed = ${m.camel}Schema.safeParse(formValues(formData, ${m.camel}Fields));
  if (!parsed.success) return ${invalid};
  const result = await save${m.name}(user.id, parsed.data);
  if (result.ok) revalidatePath(${q(m.route)});
  return result;
}

export async function update${m.name}(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser(${q(m.route)});
  const id = ${m.camel}IdSchema.safeParse({ id: formData.get("id") });
  if (!id.success) return { ok: false, message: "Unknown ${m.label.toLowerCase()}." };
  const parsed = ${m.camel}Schema.safeParse(formValues(formData, ${m.camel}Fields));
  if (!parsed.success) return ${invalid};
  const result = await save${m.name}(user.id, parsed.data, id.data.id);
  if (result.ok) revalidatePath(${q(m.route)});
  return result;
}

export async function delete${m.name}(formData: FormData): Promise<void> {
  const user = await requireUser(${q(m.route)});
  const parsed = ${m.camel}IdSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) return;
  await withUser(db, user.id, (tx) => tx.delete(${t}).where(and(eq(${t}.id, parsed.data.id), eq(${t}.ownerId, user.id))));
  revalidatePath(${q(m.route)});
}
${moves}`;
  const tables = [t, ...(booking?.duration ? [booking.duration.entity.pluralCamel] : [])];
  const pipeImports = pipelines
    .map((p) => {
      const n = pipelineName(p);
      const F = pascal(p.field.name);
      return importLine([`is${n.typeName}`, `next${F}`, `previous${F}`], `@/lib/domain/${n.module}`, body);
    })
    .join("");
  return `"use server";
${TS_HEADER}
${importLine(["and", "eq"], "drizzle-orm", body)}${importLine(["revalidatePath"], "next/cache", body)}${importLine(["z"], "zod", body)}import { db } from "@/db/client";
${importLine(tables, "@/db/app-schema", body)}import { withUser } from "@/db/with-user";
${booking ? importLine(["SLOT_MINUTES", "bookingEnd", "findConflict", "isConflictError", "isOnSlotGrid"], "@/lib/domain/booking-rules", body) : ""}${pipeImports}${importLine(["fieldErrors", "formValues"], "@/lib/form", body, ["FormState"])}import { requireUser } from "@/lib/session";
${importLine([`${m.camel}Fields`, `${m.camel}IdSchema`, `${m.camel}Schema`], `@/lib/validation/${m.kebab}`, body, [`${m.name}Input`])}
${body}`;
}

function refsOf(m: EntityModel, models: EntityModel[]): Array<{ f: FieldModel; ref: EntityModel }> {
  return m.fields.flatMap((f) => {
    const ref = f.type === "reference" ? models.find((x) => x.name === f.references) : undefined;
    return ref ? [{ f, ref }] : [];
  });
}

function optionQueries(m: EntityModel, models: EntityModel[]): { code: string; names: string[]; tables: string[] } {
  const refs = refsOf(m, models);
  const names: string[] = [];
  const tables: string[] = [];
  const lines = refs.map(({ f, ref }) => {
    const n = `${camel(f.name)}Options`;
    names.push(n);
    tables.push(ref.pluralCamel);
    const labelCol = ref.displayField ? `${ref.pluralCamel}.${ref.displayField}` : `${ref.pluralCamel}.id`;
    return `    ${n}: await tx.select({ value: ${ref.pluralCamel}.id, label: ${labelCol} }).from(${ref.pluralCamel}).orderBy(asc(${labelCol})),`;
  });
  return { code: lines.join("\n"), names, tables };
}

function cellExpr(m: EntityModel, f: FieldModel, models: EntityModel[], row: string): string {
  const ref = f.type === "reference" ? models.find((x) => x.name === f.references) : undefined;
  if (ref) return `{optionLabel(${camel(f.name)}Options, ${row}.${f.name})}`;
  return `{formatValue(${row}.${f.name})}`;
}

function listPageTsx(m: EntityModel, models: EntityModel[], rules: DomainRules): string {
  const pipeline = rules.pipeline.find((p) => p.entity.name === m.name);
  const progress = rules.progress.find((p) => p.entity.name === m.name);
  const opts = optionQueries(m, models);
  const shown = m.fields.filter((f) => f.type !== "text").slice(0, 6);
  const optionsArg = opts.names.length ? `withOptions(${m.camel}FormFields, { ${refsOf(m, models).map(({ f }) => `${f.name}: ${camel(f.name)}Options`).join(", ")} })` : `${m.camel}FormFields`;
  const rowActions = (row: string) => `<div className="row-actions">
                    <Link href={\`${m.route}/\${${row}.id}\`}>Edit<span className="visually-hidden"> ${jsxText(m.label.toLowerCase())}</span></Link>
                    <form action={delete${m.name}}>
                      <input type="hidden" name="id" value={${row}.id} />
                      <button className="button" data-variant="ghost" type="submit">
                        Delete<span className="visually-hidden"> ${jsxText(m.label.toLowerCase())}</span>
                      </button>
                    </form>
                  </div>`;
  let listing: string;
  if (pipeline) {
    const n = pipelineName(pipeline);
    const F = pascal(pipeline.field.name);
    const titleField = m.displayField ?? "id";
    listing = `<div className="board">
          {${n.constName}.map((column) => (
            <section key={column} aria-labelledby={\`col-\${column}\`} className="card">
              <h3 id={\`col-\${column}\`}>
                {column} ({groups[column].length})
              </h3>
              <ul>
                {groups[column].map((row) => (
                  <li key={row.id}>
                    <strong>{formatValue(row.${titleField})}</strong>
${shown.filter((f) => f.name !== titleField && f.name !== pipeline.field.name).slice(0, 2).map((f) => `                    <div>${jsxText(f.label)}: ${cellExpr(m, f, models, "row")}</div>`).join("\n")}
                    <div className="row-actions">
                      <form action={move${m.name}${F}}>
                        <input type="hidden" name="id" value={row.id} />
                        <input type="hidden" name="direction" value="previous" />
                        <button className="button" data-variant="ghost" type="submit" disabled={column === ${n.constName}[0]}>
                          ←<span className="visually-hidden"> Move to previous ${jsxText(pipeline.field.label.toLowerCase())}</span>
                        </button>
                      </form>
                      <form action={move${m.name}${F}}>
                        <input type="hidden" name="id" value={row.id} />
                        <input type="hidden" name="direction" value="next" />
                        <button className="button" data-variant="ghost" type="submit" disabled={column === ${n.constName}[${n.constName}.length - 1]}>
                          →<span className="visually-hidden"> Move to next ${jsxText(pipeline.field.label.toLowerCase())}</span>
                        </button>
                      </form>
                    </div>
                    ${rowActions("row")}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>`;
  } else {
    listing = `<table className="data-table">
          <caption className="visually-hidden">${jsxText(m.labelPlural)}</caption>
          <thead>
            <tr>
${shown.map((f) => `              <th scope="col">${jsxText(f.label)}</th>`).join("\n")}
${progress ? `              <th scope="col">Progress</th>\n` : ""}              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
${shown.map((f) => `                <td>${cellExpr(m, f, models, "row")}</td>`).join("\n")}
${progress ? `                <td>\n                  <progress max={100} value={progressPercent(row.${progress.current.name}, row.${progress.target.name})} aria-label="Progress" /> {progressPercent(row.${progress.current.name}, row.${progress.target.name})}%\n                </td>\n` : ""}                <td>
                  ${rowActions("row")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>`;
  }
  const body = `export const metadata: Metadata = { title: ${q(m.labelPlural)} };
export const dynamic = "force-dynamic";

export default async function ${m.pluralPascal}Page() {
  const user = await requireUser(${q(m.route)});
  const { rows${opts.names.map((n) => `, ${n}`).join("")} } = await withUser(db, user.id, async (tx) => ({
    rows: await tx.select().from(${m.pluralCamel}).orderBy(desc(${m.pluralCamel}.createdAt)),
${opts.code}
  }));
${pipeline ? `  const groups = groupBy${pascal(pipeline.field.name)}(rows);\n` : ""}  return (
    <div className="container page">
      <AppNav current=${q(m.route)} />
      <h1>${jsxText(m.labelPlural)}</h1>
      <section className="card" aria-labelledby="create-title">
        <h2 id="create-title">New ${jsxText(m.label.toLowerCase())}</h2>
        <EntityForm idPrefix=${q(`new-${m.kebab}`)} fields={${optionsArg}} action={create${m.name}} submitLabel=${q(`Create ${m.label.toLowerCase()}`)} />
      </section>
      <section aria-labelledby="list-title">
        <h2 id="list-title">Your ${jsxText(m.labelPlural.toLowerCase())}</h2>
        {rows.length === 0 ? (
          <p>No ${jsxText(m.labelPlural.toLowerCase())} yet.</p>
        ) : (
        ${listing}
        )}
      </section>
    </div>
  );
}
`;
  const pipeImport = pipeline ? importLine([pipelineName(pipeline).constName, `groupBy${pascal(pipeline.field.name)}`], `@/lib/domain/${pipelineName(pipeline).module}`, body) : "";
  return `${TS_HEADER}
import type { Metadata } from "next";
import Link from "next/link";
${importLine(["asc", "desc"], "drizzle-orm", body)}import { AppNav } from "@/components/app-nav";
import { EntityForm } from "@/components/entity-form";
import { db } from "@/db/client";
${importLine([m.pluralCamel, ...opts.tables], "@/db/app-schema", body)}import { withUser } from "@/db/with-user";
${pipeImport}${progress ? `import { progressPercent } from "@/lib/domain/progress";\n` : ""}${importLine(["withOptions"], "@/lib/form", body)}${importLine(["formatValue", "optionLabel"], "@/lib/format", body)}import { requireUser } from "@/lib/session";
import { ${m.camel}FormFields } from "@/lib/validation/${m.kebab}";
import "@/styles/app.css";
${importLine([`create${m.name}`, `delete${m.name}`, ...(pipeline ? [`move${m.name}${pascal(pipeline.field.name)}`] : [])], "./actions", body)}
${body}`;
}

function editPageTsx(m: EntityModel, models: EntityModel[]): string {
  const opts = optionQueries(m, models);
  const optionsArg = opts.names.length ? `withOptions(${m.camel}FormFields, { ${refsOf(m, models).map(({ f }) => `${f.name}: ${camel(f.name)}Options`).join(", ")} })` : `${m.camel}FormFields`;
  const body = `export const metadata: Metadata = { title: ${q(`Edit ${m.label.toLowerCase()}`)} };
export const dynamic = "force-dynamic";

export default async function Edit${m.name}Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser(${q(m.route)});
  const parsed = ${m.camel}IdSchema.safeParse({ id });
  if (!parsed.success) notFound();
  const { row${opts.names.map((n) => `, ${n}`).join("")} } = await withUser(db, user.id, async (tx) => ({
    row: (await tx.select().from(${m.pluralCamel}).where(eq(${m.pluralCamel}.id, parsed.data.id)).limit(1))[0],
${opts.code}
  }));
  if (!row) notFound();
  return (
    <div className="container page">
      <AppNav current=${q(m.route)} />
      <h1>Edit ${jsxText(m.label.toLowerCase())}</h1>
      <section className="card" aria-label="Edit form">
        <EntityForm idPrefix=${q(`edit-${m.kebab}`)} fields={${optionsArg}} action={update${m.name}} recordId={row.id} defaults={toFormDefaults(row)} submitLabel="Save changes" />
      </section>
      <p>
        <Link href=${q(m.route)}>Back to ${jsxText(m.labelPlural.toLowerCase())}</Link>
      </p>
    </div>
  );
}
`;
  return `${TS_HEADER}
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
${importLine(["asc", "eq"], "drizzle-orm", body)}import { AppNav } from "@/components/app-nav";
import { EntityForm } from "@/components/entity-form";
import { db } from "@/db/client";
${importLine([m.pluralCamel, ...opts.tables], "@/db/app-schema", body)}import { withUser } from "@/db/with-user";
${importLine(["withOptions"], "@/lib/form", body)}import { toFormDefaults } from "@/lib/format";
import { requireUser } from "@/lib/session";
import { ${m.camel}FormFields, ${m.camel}IdSchema } from "@/lib/validation/${m.kebab}";
import "@/styles/app.css";
import { update${m.name} } from "../actions";

${body}`;
}

function entityFormTsx(): string {
  return `"use client";
${TS_HEADER}
import { useActionState } from "react";
import { FieldControl } from "@/components/field-control";
import { initialFormState, type FieldDescriptor, type FormState } from "@/lib/form";

/** Create/edit form bound to a server action; shows inline validation errors from the server. */
export function EntityForm({
  idPrefix,
  fields,
  action,
  recordId,
  defaults = {},
  submitLabel,
}: {
  idPrefix: string;
  fields: FieldDescriptor[];
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  recordId?: string;
  defaults?: Record<string, string | boolean>;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, initialFormState);
  return (
    <form action={formAction} noValidate>
      {recordId ? <input type="hidden" name="id" value={recordId} /> : null}
      {fields.map((field) => (
        <FieldControl key={field.name} field={field} id={\`\${idPrefix}-\${field.name}\`} error={state.errors?.[field.name]?.join(" ")} defaultValue={defaults[field.name]} />
      ))}
      <p>
        <button className="button" type="submit" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </button>
      </p>
      <p role="status" aria-live="polite" className={state.ok ? undefined : "form-status-error"}>
        {state.message}
      </p>
    </form>
  );
}
`;
}

function formatTs(): string {
  return `${TS_HEADER}
/** Display a stored value in tables (server-rendered). */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (value instanceof Date) return value.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return value.toLocaleString("en-GB");
  return String(value);
}

/** Value for <input type="datetime-local"> in local time, minute precision. */
export function toDateTimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return [d.getFullYear(), "-", pad(d.getMonth() + 1), "-", pad(d.getDate()), "T", pad(d.getHours()), ":", pad(d.getMinutes())].join("");
}

/** A database row as form defaults (dates for datetime-local, numbers as text, booleans kept). */
export function toFormDefaults(row: Record<string, unknown>): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) out[k] = "";
    else if (v instanceof Date) out[k] = toDateTimeLocal(v);
    else if (typeof v === "boolean") out[k] = v;
    else out[k] = String(v);
  }
  return out;
}

export function optionLabel(options: ReadonlyArray<{ value: string; label: string | null }>, value: unknown): string {
  return options.find((o) => o.value === value)?.label ?? "—";
}
`;
}

function navTsx(models: EntityModel[]): string {
  return `${TS_HEADER}
import Link from "next/link";

const SECTIONS = [
${models.map((m) => `  { href: ${q(m.route)}, label: ${q(m.labelPlural)} },`).join("\n")}
] as const;

export function AppNav({ current }: { current?: string }) {
  return (
    <nav className="page-nav" aria-label="Sections">
      <ul>
        {SECTIONS.map((s) => (
          <li key={s.href}>
            <Link href={s.href} aria-current={s.href === current ? "page" : undefined}>
              {s.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
`;
}

function homeTsx(ctx: GenerateContext, models: EntityModel[]): string {
  return `${TS_HEADER}
import Link from "next/link";
import { AppNav } from "@/components/app-nav";
import { site } from "@/lib/site";
import "@/styles/app.css";

export default function HomePage() {
  return (
    <div className="container page">
      <section className="hero" aria-labelledby="hero-title">
        <h1 id="hero-title">{site.name}</h1>
        <p className="lead">${jsxText(ctx.spec.summary.slice(0, 200))}</p>
        <p>
          <Link className="button" href="/sign-in">
            Sign in or create an account
          </Link>
        </p>
      </section>
      <h2>Sections</h2>
      <p>Signed-in users manage their own data; nothing is shared with other accounts unless stated.</p>
      <AppNav />
      <ul>
${models.map((m) => `        <li>\n          <strong>${jsxText(m.labelPlural)}</strong>${m.ownerScoped ? " — private to you" : " — shared catalogue, editable by its creator"}\n        </li>`).join("\n")}
      </ul>
    </div>
  );
}
`;
}

function validationTest(models: EntityModel[]): string {
  const blocks = models.map((m) => {
    const sample = `{ ${m.fields.map((f) => `${f.name}: ${f.type === "datetime" ? `new Date(${sampleFor(f, "form")})` : sampleFor(f, "form")}`).join(", ")} }`;
    const bad = m.fields
      .map((f) => ({ f, v: invalidFor(f) }))
      .filter((x) => x.v !== null)
      .slice(0, 4)
      .map(({ f, v }) => `    expect(${m.camel}Schema.safeParse({ ...valid, ${f.name}: ${v} }).success).toBe(false);`)
      .join("\n");
    const req = m.fields.find((f) => f.required && f.type !== "boolean");
    return `describe("${m.label.toLowerCase()} validation", () => {
  const valid = ${sample};

  it("accepts a complete ${m.label.toLowerCase()}", () => {
    expect(${m.camel}Schema.safeParse(valid).success).toBe(true);
  });

  it("rejects invalid values", () => {
${bad}
  });
${
  req
    ? `
  it("requires ${req.label.toLowerCase()} (empty form fields are treated as missing)", () => {
    const form = new FormData();
    const r = ${m.camel}Schema.safeParse(formValues(form, ${m.camel}Fields));
    expect(r.success).toBe(false);
    if (!r.success) expect(Object.keys(fieldErrors(r.error.issues))).toContain(${q(req.name)});
  });
`
    : ""
}});
`;
  });
  const imports = models.map((m) => `import { ${m.camel}Fields, ${m.camel}Schema } from "@/lib/validation/${m.kebab}";`).join("\n");
  return `${TS_HEADER}
import { describe, expect, it } from "vitest";
import { fieldErrors, formValues } from "@/lib/form";
${imports}

${blocks.join("\n")}`;
}

function formTest(): string {
  return `${TS_HEADER}
import { describe, expect, it } from "vitest";
import { fieldErrors, formValues, withOptions } from "@/lib/form";
import { formatValue, toDateTimeLocal, toFormDefaults } from "@/lib/format";

describe("form helpers", () => {
  it("reads typed values from FormData", () => {
    const fd = new FormData();
    fd.set("title", "  Hello ");
    fd.set("count", "3");
    fd.set("note", "");
    fd.set("done", "on");
    expect(formValues(fd, { title: "text", count: "number", note: "text", done: "boolean", other: "boolean" })).toEqual({ title: "Hello", count: 3, done: true, other: false });
  });

  it("maps issues to fields", () => {
    expect(fieldErrors([{ path: ["title"], message: "Required" }, { path: [], message: "Bad" }])).toEqual({ title: ["Required"], form: ["Bad"] });
  });

  it("formats and converts values", () => {
    expect(formatValue(null)).toBe("—");
    expect(formatValue(true)).toBe("Yes");
    expect(toDateTimeLocal(new Date(2026, 0, 5, 9, 30))).toBe("2026-01-05T09:30");
    expect(toFormDefaults({ a: null, b: 2, c: false })).toEqual({ a: "", b: "2", c: false });
    expect(withOptions([{ name: "x", label: "X", input: "select" }], { x: [{ value: "1", label: "One" }] })[0]?.options).toHaveLength(1);
  });
});
`;
}

export function generateNextjsAuth(ctx: GenerateContext): GeneratedProject {
  const out = emptyProject("nextjs-auth");
  const models = entityModels(ctx.spec);
  const rules = detectRules(ctx.spec, models);
  const f = out.files;
  f["src/db/app-schema.ts"] = schemaTs(models, rules);
  f["src/db/schema.ts"] = `${TS_HEADER}\n// Better Auth tables (app-kit) + the app's tables. drizzle.config.ts points here.\nexport * from "./auth-schema";\nexport * from "./app-schema";\n`;
  f["src/lib/form.ts"] = formLibTs();
  f["src/lib/format.ts"] = formatTs();
  f["src/components/field-control.tsx"] = fieldControlTsx();
  f["src/components/entity-form.tsx"] = entityFormTsx();
  f["src/components/app-nav.tsx"] = navTsx(models);
  f["src/styles/app.css"] = appCss();
  f["src/app/page.tsx"] = homeTsx(ctx, models);
  f["src/app/api/health/route.ts"] = healthRoute();
  if (ctx.spec.screens.some((s) => s.path === "/login")) {
    f["src/app/login/page.tsx"] = `${TS_HEADER}\nimport { redirect } from "next/navigation";\n\n/** The spec's /login screen is the app-kit sign-in page. */\nexport default function LoginPage() {\n  redirect("/sign-in");\n}\n`;
  }
  for (const m of models) {
    const dir = `src/app${m.route}`;
    f[`src/lib/validation/${m.kebab}.ts`] = validationTs(m, models);
    f[`${dir}/actions.ts`] = actionsTs(m, rules);
    f[`${dir}/page.tsx`] = listPageTsx(m, models, rules);
    f[`${dir}/[id]/page.tsx`] = editPageTsx(m, models);
  }
  f["test/validation.test.ts"] = validationTest(models);
  f["test/form.test.ts"] = formTest();
  if (rules.booking) {
    f["src/lib/domain/booking-rules.ts"] = bookingRulesTs();
    f["test/booking-rules.test.ts"] = bookingRulesTest("@/lib/domain/booking-rules");
  }
  for (const p of rules.pipeline) addPipeline(f, p);
  if (rules.progress.length) {
    f["src/lib/domain/progress.ts"] = progressTs();
    f["test/progress.test.ts"] = progressTest("@/lib/domain/progress");
  }

  if (ctx.openapi) {
    const integration = generateIntegration(ctx.openapi.api, { auth: true });
    Object.assign(f, integration.files);
    out.setup.push(...integration.setup);
    out.notes.push(...integration.notes);
    f[`src/app/integrations/${integration.slug}/page.tsx`] = `${TS_HEADER}
${integration.explorer.importLine}
import { AppNav } from "@/components/app-nav";
import { requireUser } from "@/lib/session";
import "@/styles/app.css";

export const dynamic = "force-dynamic";

export default async function IntegrationPage() {
  await requireUser(${q(`/integrations/${integration.slug}`)});
  return (
    <div className="container page">
      <AppNav />
      <h1>${jsxText(ctx.openapi.api.title)}</h1>
      ${integration.explorer.jsx}
    </div>
  );
}
`;
  }
  const existingSql = ctx.files.filter((p) => /^drizzle\/\d{4}_[\w-]+\.sql$/.test(p)).length;
  out.setup.push(`npm install --no-audit --no-fund zod@${ZOD_VERSION}`, "npx drizzle-kit generate --name app");
  if (rules.booking) {
    const b = rules.booking;
    const idx = String(existingSql + 1).padStart(4, "0");
    out.setup.push("npx drizzle-kit generate --custom --name booking_rules");
    out.postFiles[`drizzle/${idx}_booking_rules.sql`] = `${SQL_HEADER}
-- No double booking: two ${b.entity.labelPlural.toLowerCase()} of the same ${b.resource.label.toLowerCase()} may not overlap in time.
-- Constraints are checked against all rows, regardless of row-level security.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "${b.entity.table}" ADD CONSTRAINT "${b.entity.table}_no_overlap" EXCLUDE USING gist ("${b.resource.column}" WITH =, tstzrange("${b.start.column}", "ends_at") WITH &&);
--> statement-breakpoint
ALTER TABLE "${b.entity.table}" ADD CONSTRAINT "${b.entity.table}_ends_after_start" CHECK ("ends_at" > "${b.start.column}");
`;
  }
  out.verify.push("npm run typecheck", "npm run lint");
  out.autofix = "npx eslint . --fix";
  out.notes.push(
    "Auth, sessions and the database client come from the Forge app-kit (Better Auth + Drizzle); every page and server action calls requireUser() and queries inside withUser(), so Postgres row-level security limits each user to their own rows.",
    `Migrations: drizzle/0001_app.sql is generated by drizzle-kit from src/db/app-schema.ts (tables, RLS policies)${rules.booking ? ", plus a custom booking_rules migration with an exclusion constraint against overlapping bookings (needs the btree_gist extension)" : ""}. Run \`npm run db:migrate\` with DATABASE_URL set before using the app.`,
  );
  if (models.some((m) => !m.ownerScoped)) out.notes.push(`Shared entities (${models.filter((m) => !m.ownerScoped).map((m) => m.labelPlural).join(", ")}) are readable by every signed-in user and editable only by their creator; there are no separate staff/admin roles.`);
  if (rules.booking) out.notes.push("Booking times are interpreted in the server's time zone and must start on a 15-minute grid.");
  return out;
}

function addPipeline(f: Record<string, string>, p: PipelineRule): void {
  const n = pipelineName(p);
  f[`src/lib/domain/${n.module}.ts`] = pipelineTs(p);
  f[`test/${n.module}.test.ts`] = pipelineTest(p, `@/lib/domain/${n.module}`);
}
