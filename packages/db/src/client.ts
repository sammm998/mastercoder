import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as schema from "./schema.js";

export type Db = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  sql: postgres.Sql;
  close(): Promise<void>;
}

export function connect(url = process.env.DATABASE_URL || "postgres://forge:forge@localhost:5432/forge", max = 10): DbHandle {
  const sql = postgres(url, { max, onnotice: () => undefined });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}

export const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

export async function runMigrations(url?: string): Promise<void> {
  const h = connect(url, 1);
  try {
    await h.sql`CREATE EXTENSION IF NOT EXISTS vector`;
    await migrate(h.db, { migrationsFolder });
  } finally {
    await h.close();
  }
}
