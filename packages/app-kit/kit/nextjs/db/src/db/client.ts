import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

declare global {
  var __forgeSql: ReturnType<typeof postgres> | undefined;
}

// One pool per server process (survives Next.js dev hot reloads). Connects lazily on first query.
const client = globalThis.__forgeSql ?? postgres(process.env.DATABASE_URL ?? "postgres://localhost:5432/app", { max: 10, prepare: false });
if (process.env.NODE_ENV !== "production") globalThis.__forgeSql = client;

export const db = drizzle(client, { schema });
export type Database = typeof db;
