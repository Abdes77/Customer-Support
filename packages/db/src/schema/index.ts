/**
 * The Drizzle schema. One file per area of ARCHITECTURE §8; policies are declared with the
 * tables (see `policies.ts`). After changing anything here run `pnpm db:generate`, review the
 * new migration, and add any new table to the isolation matrix.
 */
export * from "./tables";
export * from "./vocab";
