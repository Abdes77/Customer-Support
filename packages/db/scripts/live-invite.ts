/**
 * pnpm --filter @repo/db live:invite --email you@example.com
 *
 * The live check of people management's invitation path (C18, docs/HUMAN_TODO.md): with
 * NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_URL and DATABASE_URL of a real
 * Supabase project, it does what the admin panel's "Add and invite" does for one address,
 * without giving it any access: a new address gets Supabase's "Invite user" email, an address
 * that already has an account gets the "Magic Link" email. Open the email and follow the link:
 * it must land on <APP_URL>/auth/confirm and end on the sign-in page with "no access" (the
 * address belongs to nothing yet). Run it twice with the same address to see both emails.
 *
 * The service-role key is read from the environment and never printed.
 */
import { parseArgs } from "node:util";

import { ConfigError, ValidationError } from "@repo/core";
import { getEnv, requireEnv } from "@repo/core/env";

import { createDatabase } from "../src/database";
import { createSupabaseAuthAdmin } from "../src/supabase-auth-admin";
import { fail, loadRootEnv } from "./env";

async function main(): Promise<void> {
  loadRootEnv();
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((argument) => argument !== "--"),
    options: { email: { type: "string" } },
  });
  const email = values.email?.normalize("NFKC").trim().toLowerCase();
  if (email === undefined || !/^[^@\s]+@[^@\s]+$/.test(email)) {
    throw new ValidationError("Usage: pnpm --filter @repo/db live:invite --email you@example.com");
  }
  const env = getEnv();
  const config = requireEnv(
    env,
    "DATABASE_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "APP_URL",
  );
  const db = createDatabase({
    url: config.DATABASE_URL,
    max: 1,
    applicationName: "hsrb-live-invite",
  });
  try {
    if (await db.localAuth.isAvailable()) {
      throw new ConfigError("DATABASE_URL is a local database: point it at the Supabase project.");
    }
    const admin = createSupabaseAuthAdmin({
      url: config.NEXT_PUBLIC_SUPABASE_URL,
      serviceRoleKey: config.SUPABASE_SERVICE_ROLE_KEY,
    });
    const redirectTo = new URL("/auth/confirm", config.APP_URL).toString();
    const existing = await db.directory.findUserByEmail(email);
    if (existing === null) {
      const invited = await admin.inviteUser({ email, redirectTo });
      if (invited === "exists") {
        await admin.sendSignInLink({ email, redirectTo });
        console.log("The address already had an account: Supabase sent the Magic Link email.");
      } else {
        console.log("PASS so far: Supabase created the account and sent the Invite user email.");
      }
    } else {
      await admin.sendSignInLink({ email, redirectTo });
      console.log("The address has an account: Supabase sent the Magic Link email.");
    }
    console.log(`Now open the email. The link must land on ${redirectTo}.`);
  } finally {
    await db.close();
  }
}

main().catch(fail);
