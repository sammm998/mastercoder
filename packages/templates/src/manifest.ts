import { z } from "zod";

export const TemplateKind = z.enum(["app", "website", "mobile", "backend"]);
export type TemplateKind = z.infer<typeof TemplateKind>;

/** Standard 5-field cron expression (minute hour day-of-month month day-of-week). */
const CRON_FIELD = /^(\*|\d+|\d+-\d+|\*\/\d+|\d+(-\d+)?\/\d+)(,(\*|\d+|\d+-\d+|\*\/\d+|\d+(-\d+)?\/\d+))*$/;

export const CronSpecSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "cron name must be kebab-case"),
  schedule: z
    .string()
    .refine((s) => {
      const parts = s.trim().split(/\s+/);
      return parts.length === 5 && parts.every((p) => CRON_FIELD.test(p));
    }, "schedule must be a 5-field cron expression"),
  /** HTTP path the Forge scheduler POSTs to (with `Authorization: Bearer $CRON_SECRET`). */
  path: z.string().startsWith("/"),
});
export type CronSpec = z.infer<typeof CronSpecSchema>;

const command = z.string().min(1);
const route = z.string().startsWith("/");

/** `forge.json` at the root of every generated project. Read by the agent, quality gates and deployers. */
export const ForgeManifestSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().min(1),
    kind: TemplateKind,
    language: z.enum(["typescript", "python"]).default("typescript"),
    install: command,
    dev: command,
    build: command,
    test: command,
    typecheck: command,
    lint: command,
    e2e: command.optional(),
    /** Port the dev server listens on. */
    port: z.number().int().min(1).max(65535),
    /** Port the production container (Dockerfile) listens on. Defaults to `port`. */
    containerPort: z.number().int().min(1).max(65535).optional(),
    /** Routes visual QA, Lighthouse and the smoke test visit. */
    publicRoutes: z.array(route),
    lighthouse: z.boolean(),
    healthPath: route.optional(),
    /** Scheduled jobs (added by the app-kit `cron` feature). */
    crons: z.array(CronSpecSchema).optional(),
    /** Installed app-kit features. */
    features: z.array(z.string()).optional(),
  })
  .strict();
export type ForgeManifest = z.infer<typeof ForgeManifestSchema>;

export function parseManifest(json: string | unknown): ForgeManifest {
  const raw = typeof json === "string" ? (JSON.parse(json) as unknown) : json;
  return ForgeManifestSchema.parse(raw);
}

/** Container port for deploys: `containerPort` when set, otherwise the dev `port`. */
export function containerPortOf(m: Pick<ForgeManifest, "port" | "containerPort">): number {
  return m.containerPort ?? m.port;
}
