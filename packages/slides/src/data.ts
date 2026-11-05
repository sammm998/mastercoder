import { z } from "zod";
import { ChartSchema } from "./schema.js";

/** Optional facts the caller supplies; generators must use these instead of inventing numbers. */
export const ContentDataSchema = z.object({
  metrics: z.array(z.object({ value: z.string().max(24), label: z.string().max(120) })).max(6).optional(),
  charts: z.array(ChartSchema).max(6).optional(),
  team: z.array(z.object({ name: z.string(), role: z.string() })).max(8).optional(),
  competitors: z.array(z.string()).max(8).optional(),
  quotes: z.array(z.object({ text: z.string(), author: z.string() })).max(4).optional(),
  segments: z.array(z.object({ name: z.string(), size: z.string().optional(), growth: z.string().optional(), needs: z.string().optional() })).max(8).optional(),
  ask: z.object({ amount: z.string(), useOfFunds: z.array(z.string()).max(5).optional(), runway: z.string().optional() }).optional(),
  contact: z.string().max(200).optional(),
});
export type ContentData = z.infer<typeof ContentDataSchema>;
