/**
 * pnpm db:create-admin --agency "Agency name" --slug agency-slug --email person@example.com
 *
 * Makes a person an agency_admin: the first step on a new installation, where no admin
 * exists yet to invite anyone. Creates the agency when the slug is new.
 *
 * The person must already exist as an auth user:
 * - Supabase: create them in the dashboard (Authentication, Users, Add user), or set
 *   SUPABASE_SERVICE_ROLE_KEY and this script creates them through the admin API;
 * - local database: add --password to create them in the local sign-in store.
 */
import { parseArgs } from "node:util";

import { ConfigError, type UserId, ValidationError } from "@repo/core";
import { getEnv, hasEnv, requireEnv } from "@repo/core/env";

import { createDatabase } from "../src/database";
import { recordSystemAudit } from "../src/repositories/audit";
import { agencyMemberships } from "../src/schema/tables";
import { createSupabaseAuthAdmin } from "../src/supabase-auth-admin";
import { fail, loadRootEnv } from "./env";

async function main(): Promise<void> {
  loadRootEnv();
  const { values } = parseArgs({
    // pnpm passes a literal "--" through when the command is written with one.
    args: process.argv.slice(2).filter((argument) => argument !== "--"),
    options: {
      agency: { type: "string" },
      slug: { type: "string" },
      email: { type: "string" },
      password: { type: "string" },
    },
  });
  const { agency, slug, email, password } = values;
  if (slug === undefined || email === undefined) {
    throw new ValidationError(
      'Usage: pnpm db:create-admin --agency "Agency name" --slug agency-slug --email person@example.com',
    );
  }
  const env = getEnv();
  if (env.DATABASE_URL === undefined) throw new ConfigError("Set DATABASE_URL.");
  const db = createDatabase({ url: env.DATABASE_URL, max: 2, applicationName: "hsrb-admin" });
  try {
    let userId: UserId | undefined = (await db.directory.findUserByEmail(email))?.id;
    if (userId === undefined) {
      if (await db.localAuth.isAvailable()) {
        if (password === undefined) {
          throw new ValidationError(`No user ${email} yet. Add --password to create one locally.`);
        }
        userId = (await db.localAuth.upsertUser({ email, password })).id;
      } else if (hasEnv(env, "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")) {
        const supabase = requireEnv(env, "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY");
        userId = await createSupabaseAuthAdmin({
          url: supabase.NEXT_PUBLIC_SUPABASE_URL,
          serviceRoleKey: supabase.SUPABASE_SERVICE_ROLE_KEY,
        }).ensureUser(db, { email, password });
      } else {
        throw new ValidationError(
          `No user ${email} yet. Create them in the Supabase dashboard (Authentication, Users) and run this again.`,
        );
      }
    }

    let agencyRow = await db.platform.findAgencyBySlug(slug);
    if (agencyRow === null) {
      if (agency === undefined) {
        throw new ValidationError(
          `There is no agency "${slug}". Add --agency "Name" to create it.`,
        );
      }
      agencyRow = { id: (await db.platform.createAgency({ name: agency, slug })).id, name: agency };
      console.log(`Created agency "${agency}" (${slug}).`);
    }

    const adminId = userId;
    await db.forAgency(agencyRow.id).run(async (ctx) => {
      await ctx.tx
        .insert(agencyMemberships)
        .values({ agencyId: ctx.tenant.agencyId, userId: adminId, role: "agency_admin" })
        .onConflictDoUpdate({
          target: [agencyMemberships.agencyId, agencyMemberships.userId],
          set: { role: "agency_admin" },
        });
      await recordSystemAudit(
        ctx,
        { type: "system", label: "db:create-admin" },
        {
          action: "agency_membership.grant",
          targetType: "user",
          targetId: adminId,
          summary: "Made agency_admin from the command line",
        },
      );
    });
    console.log(`${email} is now agency_admin of "${agencyRow.name}".`);
  } finally {
    await db.close();
  }
}

main().catch(fail);
