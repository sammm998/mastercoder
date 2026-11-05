import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// INSECURE FIXTURE: Drizzle table without RLS / policies.
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  action: text("action").notNull(),
  at: timestamp("at").defaultNow(),
});
