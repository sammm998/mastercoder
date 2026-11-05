import { sql } from "drizzle-orm";
import { pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    action: text("action").notNull(),
    at: timestamp("at").defaultNow(),
  },
  (t) => [
    pgPolicy("audit_log_owner_read", {
      for: "select",
      using: sql`${t.userId} = current_setting('app.user_id', true)::uuid`,
    }),
  ],
).enableRLS();
