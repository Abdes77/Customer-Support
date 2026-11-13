import { readFileSync } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";

import { decryptSecret, encryptSecret, type Keyring, keyringFromEnv } from "./crypto/secrets";
import { connect } from "./internal/client";
import { detectDatabaseFlavor, MIGRATIONS_FOLDER } from "./migrate";

/**
 * Checks that a database is set up the way this system needs it. `pnpm db:doctor` prints
 * the result; it is the live check to run against a new Supabase project after
 * `pnpm db:migrate` (docs/HUMAN_TODO.md). It reads only, and changes nothing.
 */
export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

type Rows = readonly Record<string, unknown>[];

export async function runDoctor(options: {
  readonly url: string;
  /** Default: the key ring from the environment. Pass null to skip the encryption check. */
  readonly keyring?: Keyring | null;
}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const connection = connect(options.url, { max: 1, applicationName: "hsrb-doctor" });
  const { db } = connection;
  const query = async (statement: ReturnType<typeof sql>) =>
    (await db.execute(statement)) as unknown as Rows;

  try {
    try {
      await query(sql`select 1`);
      add("Connection", true, "The database answers.");
    } catch (error) {
      add("Connection", false, (error as Error).message);
      return checks;
    }

    const flavor = await detectDatabaseFlavor(db);
    add(
      "Supabase roles and auth schema",
      flavor !== "plain",
      flavor === "supabase"
        ? "Supabase database."
        : flavor === "supabase_compat"
          ? "Plain PostgreSQL with the compatibility bootstrap (local or CI)."
          : "Missing. Run `pnpm db:migrate`.",
    );

    const [role] = await query(sql`
      select current_user as name, (rolsuper or rolbypassrls) as bypasses
        from pg_roles where rolname = current_user`);
    add(
      "Connection role bypasses row-level security",
      role?.["bypasses"] === true,
      role?.["bypasses"] === true
        ? `"${String(role["name"])}" may run the cross-tenant lookups; everything else switches to a restricted role.`
        : `"${String(role?.["name"])}" is subject to row-level security: webhook and API-key lookups would find nothing. Connect as the "postgres" role.`,
    );

    for (const restricted of ["authenticated", "app_system"]) {
      try {
        const current = await db.transaction(async (tx) => {
          await tx.execute(sql`select set_config('role', ${restricted}, true)`);
          const rows = (await tx.execute(sql`select current_user as name`)) as unknown as Rows;
          return rows[0]?.["name"];
        });
        add(`Can switch to role ${restricted}`, current === restricted, "SET ROLE works.");
      } catch (error) {
        add(`Can switch to role ${restricted}`, false, (error as Error).message);
      }
    }

    let applied = -1;
    try {
      const rows = await query(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
      applied = Number(rows[0]?.["n"]);
    } catch {
      applied = -1;
    }
    const journal = JSON.parse(
      readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
    ) as { entries: unknown[] };
    add(
      "Migrations",
      applied === journal.entries.length,
      applied === journal.entries.length
        ? `All ${applied} migrations are applied.`
        : `${Math.max(applied, 0)} of ${journal.entries.length} applied. Run \`pnpm db:migrate\`.`,
    );
    if (applied < 0) return checks;

    const schemaAccess = await query(sql`
      select r.role, s.name as schema
        from unnest(array['authenticated', 'app_system']) as r(role)
        cross join unnest(array['public', 'app']) as s(name)
       where not has_schema_privilege(r.role, s.name, 'usage')`);
    add(
      "Restricted roles can use the schemas",
      schemaAccess.length === 0,
      schemaAccess.length === 0
        ? "authenticated and app_system have USAGE on public and app."
        : `Missing USAGE: ${schemaAccess
            .map((row) => `${String(row["role"])} on ${String(row["schema"])}`)
            .join(", ")}. Run \`pnpm db:migrate\`.`,
    );

    const unprotected = await query(sql`
      select c.relname as name
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p')
         and (not c.relrowsecurity or not c.relforcerowsecurity
              or not exists (select 1 from pg_policies p
                              where p.schemaname = 'public' and p.tablename = c.relname))
       order by 1`);
    add(
      "Row-level security on every table",
      unprotected.length === 0,
      unprotected.length === 0
        ? "Enabled and forced, with policies, on every table."
        : `Not protected: ${unprotected.map((row) => String(row["name"])).join(", ")}. Run \`pnpm db:migrate\`.`,
    );

    const drift = await query(sql`
      with expected as (
        select p.tablename as name, r.role, c.command
          from pg_policies p
          cross join lateral unnest(p.roles::text[]) as r(role)
          cross join lateral unnest(
            case when p.cmd = 'ALL' then array['SELECT', 'INSERT', 'UPDATE', 'DELETE']
                 else array[p.cmd] end) as c(command)
         where p.schemaname = 'public'
      ), actual as (
        select table_name::text as name, grantee::text as role, privilege_type::text as command
          from information_schema.role_table_grants
         where table_schema = 'public'
           and grantee in ('authenticated', 'app_system', 'anon', 'PUBLIC')
      )
      select name, role, command, 'missing' as problem
        from (select * from expected except select * from actual) m
      union all
      select name, role, command, 'extra' as problem
        from (select * from actual except select * from expected) e
      limit 20`);
    add(
      "Table privileges match the policies",
      drift.length === 0,
      drift.length === 0
        ? "Each restricted role holds exactly the commands its policies cover; anon holds none."
        : `Out of sync (${drift
            .map(
              (row) =>
                `${String(row["problem"])} ${String(row["command"])} on ${String(row["name"])} for ${String(row["role"])}`,
            )
            .join("; ")}). Run \`pnpm db:migrate\`.`,
    );

    if (options.keyring !== null) {
      try {
        const keyring = options.keyring ?? keyringFromEnv();
        const binding = { agencyId: "a", businessId: "b", purpose: "doctor", recordId: "r" };
        const ok =
          decryptSecret(encryptSecret("round trip", binding, keyring), binding, keyring) ===
          "round trip";
        add(
          "Credential encryption key",
          ok,
          `Key "${keyring.primaryKeyId}" encrypts and decrypts.`,
        );
      } catch (error) {
        add("Credential encryption key", false, (error as Error).message);
      }
    }
    return checks;
  } finally {
    await connection.client.end({ timeout: 5 });
  }
}
