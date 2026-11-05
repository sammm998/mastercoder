import { z } from "zod";

export const FieldSchema = z.object({
  name: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
  type: z.enum(["string", "text", "number", "integer", "boolean", "date", "datetime", "email", "url", "enum", "reference"]),
  required: z.boolean().default(true),
  enumValues: z.array(z.string()).optional(),
  references: z.string().optional(),
});

export const EntitySchema = z.object({
  name: z.string().regex(/^[A-Z][A-Za-z0-9]*$/),
  description: z.string().default(""),
  fields: z.array(FieldSchema).min(1),
  /** Rows belong to the signed-in user (RLS owner policy). */
  ownerScoped: z.boolean().default(true),
});

export const AcceptanceTestSchema = z.object({
  id: z.string(),
  title: z.string(),
  given: z.string(),
  when: z.string(),
  then: z.string(),
  /** Optional ready-to-run Playwright body (uses `page` and `expect`). */
  playwright: z.string().optional(),
});

export const SpecSchema = z.object({
  title: z.string(),
  summary: z.string(),
  kind: z.enum(["app", "website", "mobile", "backend"]),
  template: z.string().optional(),
  userStories: z.array(z.string()).min(1),
  entities: z.array(EntitySchema).default([]),
  screens: z.array(z.object({ path: z.string(), name: z.string(), purpose: z.string(), public: z.boolean().default(false) })).default([]),
  integrations: z.array(z.string()).default([]),
  auth: z.boolean().default(false),
  acceptanceTests: z.array(AcceptanceTestSchema).min(3).max(10),
  designNotes: z.string().default(""),
  tasks: z.array(z.object({ id: z.string(), title: z.string(), dependsOn: z.array(z.string()).default([]) })).default([]),
});

export type Spec = z.infer<typeof SpecSchema>;
export type Entity = z.infer<typeof EntitySchema>;
export type Field = z.infer<typeof FieldSchema>;
