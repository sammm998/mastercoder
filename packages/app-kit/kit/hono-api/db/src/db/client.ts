import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

// Connects lazily on first query.
const client = postgres(process.env.DATABASE_URL ?? "postgres://localhost:5432/app", { max: 10 });

export const db = drizzle(client, { schema });
export type Database = typeof db;

/** Close the pool (graceful shutdown, tests). */
export function closeDb(): Promise<void> {
  return client.end({ timeout: 5 });
}
