import { defineConfig } from "drizzle-kit";

/**
 * Used by `pnpm db:generate` only (it compares the schema with the last snapshot and needs
 * no database). Migrations are applied with `pnpm db:migrate`, never with drizzle-kit, so
 * the compatibility bootstrap and the privilege sync always run.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/tables.ts",
  out: "./drizzle",
  strict: true,
  verbose: false,
});
