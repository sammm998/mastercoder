import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  // Migrations run as the table owner; the app itself connects with a non-owner role (RLS).
  dbCredentials: { url: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL ?? "" },
  strict: true,
  verbose: true,
});
