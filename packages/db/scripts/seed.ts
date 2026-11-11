/**
 * pnpm db:seed
 *
 * Loads the demo data (one agency, two businesses, four users, sample conversations and
 * leads) into the database in DATABASE_URL. Run `pnpm db:migrate` first. Running it again
 * replaces the demo agency.
 *
 * It refuses to run against production. On a Supabase database it creates the demo users
 * through the Supabase Auth admin API, which needs NEXT_PUBLIC_SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY.
 */
import { ConfigError } from "@repo/core";
import { deploymentInfo, getEnv, hasEnv, isProduction, requireEnv } from "@repo/core/env";

import { createDatabase } from "../src/database";
import { DEMO_PASSWORD, seedDemoData } from "../src/seed/demo";
import { createSupabaseAuthAdmin } from "../src/supabase-auth-admin";
import { fail, loadRootEnv } from "./env";

async function main(): Promise<void> {
  loadRootEnv();
  if (isProduction() || deploymentInfo().environment === "production") {
    throw new ConfigError("The seed never runs in production.");
  }
  const env = getEnv();
  if (env.DATABASE_URL === undefined) {
    throw new ConfigError(
      "Set DATABASE_URL. Copy .env.example to .env.local for local development.",
    );
  }
  const db = createDatabase({ url: env.DATABASE_URL, max: 2, applicationName: "hsrb-seed" });
  try {
    const local = await db.localAuth.isAvailable();
    if (!local && env.SEED_USER_PASSWORD === undefined) {
      // A hosted project must not get users with a password that is written in the repo.
      throw new ConfigError("Set SEED_USER_PASSWORD to seed a Supabase database.");
    }
    let authAdmin: ReturnType<typeof createSupabaseAuthAdmin> | undefined;
    if (!local && hasEnv(env, "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")) {
      const supabase = requireEnv(env, "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY");
      authAdmin = createSupabaseAuthAdmin({
        url: supabase.NEXT_PUBLIC_SUPABASE_URL,
        serviceRoleKey: supabase.SUPABASE_SERVICE_ROLE_KEY,
      });
    }
    const summary = await seedDemoData(db, {
      password: env.SEED_USER_PASSWORD ?? DEMO_PASSWORD,
      createAuthUser:
        authAdmin === undefined ? undefined : (input) => authAdmin.ensureUser(db, input),
    });

    console.log("Demo data loaded.\n");
    console.log("Businesses:");
    for (const business of summary.businesses) {
      console.log(`  ${business.name} (${business.segment})`);
    }
    console.log("\nUsers (sign in with the password in SEED_USER_PASSWORD, or the demo");
    console.log("password documented in packages/db/src/seed/demo.ts):");
    for (const user of summary.users) {
      console.log(`  ${user.email.padEnd(32)} ${user.role}`);
    }
    console.log("\nRows written:");
    for (const [table, count] of Object.entries(summary.counts)) {
      console.log(`  ${table.padEnd(24)} ${count}`);
    }
  } finally {
    await db.close();
  }
}

main().catch(fail);
