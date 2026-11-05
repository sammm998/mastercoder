import { sql } from "drizzle-orm";
import type { Database } from "./client.js";

export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Run `fn` in a transaction where `app.user_id` is set to `userId`, so row-level-security owner
 * policies (forge_enable_owner_rls) only expose that user's rows. The setting is transaction-local.
 */
export async function withUser<T>(database: Database, userId: string, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  if (!userId) throw new Error("withUser requires a user id");
  return database.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}
