import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Editable site content documents (one row per key, e.g. "site"). */
export const cmsContent = pgTable("cms_content", {
  key: text("key").primaryKey(),
  data: jsonb("data").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by"),
});
