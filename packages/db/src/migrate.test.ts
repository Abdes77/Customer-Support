import { readFileSync } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "./database";
import { runDoctor } from "./doctor";
import { connect, type Connection } from "./internal/client";
import { detectDatabaseFlavor, migrateDatabase, MIGRATIONS_FOLDER } from "./migrate";
import * as tables from "./schema/tables";
import { agencies } from "./schema/tables";
import { createEmptyTestDatabase, createTestKeyring } from "./testing";

type Rows = readonly Record<string, unknown>[];

describe("migrations on an empty database", () => {
  let target: Awaited<ReturnType<typeof createEmptyTestDatabase>>;
  let connection: Connection;
  const query = async (statement: ReturnType<typeof sql>) =>
    (await connection.db.execute(statement)) as unknown as Rows;

  beforeAll(async () => {
    target = await createEmptyTestDatabase();
    connection = connect(target.url, { max: 1 });
  });

  afterAll(async () => {
    await connection?.client.end({ timeout: 5 });
    await target?.dispose();
  });

  it("starts from a database with nothing in it", async () => {
    // A stock database lets every role into schema public. Take that away, so the test
    // proves the migrations grant what the restricted roles need themselves.
    await query(sql`revoke all on schema public from public`);
    expect(await detectDatabaseFlavor(connection.db)).toBe("plain");
    const rows = await query(
      sql`select count(*)::int as n from pg_tables where schemaname = 'public'`,
    );
    expect(rows[0]?.["n"]).toBe(0);
  });

  it("applies cleanly, bootstrapping the Supabase names first", async () => {
    const log: string[] = [];
    const result = await migrateDatabase({ url: target.url, log: (line) => log.push(line) });
    const journal = JSON.parse(
      readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
    ) as { entries: unknown[] };

    expect(result).toEqual({
      flavor: "plain",
      compatApplied: true,
      appliedCount: journal.entries.length,
    });
    expect(log.join("\n")).toContain("compatibility bootstrap");
    expect(await detectDatabaseFlavor(connection.db)).toBe("supabase_compat");
  });

  it("creates every table of the data model", async () => {
    const rows = await query(
      sql`select tablename as name from pg_tables where schemaname = 'public' order by 1`,
    );
    expect(rows.map((row) => row["name"])).toEqual([
      "agencies",
      "agency_memberships",
      "alerts",
      "api_keys",
      "attachments",
      "audit_log",
      "bookings",
      "business_memberships",
      "business_playbook_overrides",
      "businesses",
      "channel_connection_secrets",
      "channel_connections",
      "contact_identities",
      "contacts",
      "conversation_turns",
      "conversations",
      "dead_letters",
      "escalations",
      "import_runs",
      "integration_connection_secrets",
      "integration_connections",
      "integration_events",
      "internal_notes",
      "knowledge_items",
      "lead_events",
      "lead_fields",
      "lead_reports",
      "leads",
      "message_parts",
      "message_templates",
      "messages",
      "model_calls",
      "pending_delivery_statuses",
      "playbook_generations",
      "playbook_versions",
      "routing_decisions",
      "scheduled_jobs",
      "segments",
      "setting_values",
      "setting_versions",
      "takeover_locks",
      "usage_counters",
      "users",
      "widget_sessions",
    ]);
  });

  it("lets the restricted roles work without any grant to PUBLIC", async () => {
    const access = await query(sql`
      select has_schema_privilege('authenticated', 'public', 'usage') as user_public,
             has_schema_privilege('app_system', 'public', 'usage') as system_public,
             has_schema_privilege('anon', 'public', 'usage') as anon_public,
             has_schema_privilege('authenticated', 'app', 'usage') as user_app,
             has_schema_privilege('app_system', 'app', 'usage') as system_app,
             has_schema_privilege('anon', 'app', 'usage') as anon_app`);
    expect(access[0]).toEqual({
      user_public: true,
      system_public: true,
      anon_public: false,
      user_app: true,
      system_app: true,
      anon_app: false,
    });

    // End to end: both scopes can query tables by their unqualified names.
    const db = createDatabase({ url: target.url, max: 1, keyring: createTestKeyring() });
    try {
      const { id: agencyId } = await db.platform.createAgency({ name: "Probe", slug: "probe" });
      const seen = await db
        .forAgency(agencyId)
        .run(({ tx }) => tx.select({ id: agencies.id }).from(agencies));
      expect(seen).toEqual([{ id: agencyId }]);
      const user = await db.localAuth.upsertUser({ email: "probe@example.com" });
      const asUser = await db
        .asUser({ id: user.id })
        .run(({ tx }) => tx.select({ id: agencies.id }).from(agencies));
      expect(asUser).toEqual([]);
      await db.localAuth.deleteUser(user.id);
      await db.platform.deleteAgency(agencyId);
    } finally {
      await db.close();
    }
  });

  it("is a no-op when run again", async () => {
    const before = await query(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    const result = await migrateDatabase({ url: target.url });
    const after = await query(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    expect(result.flavor).toBe("supabase_compat");
    expect(after).toEqual(before);
  });

  it("passes every doctor check", async () => {
    const checks = await runDoctor({ url: target.url, keyring: createTestKeyring() });
    expect(checks.filter((check) => !check.ok)).toEqual([]);
    expect(checks.length).toBeGreaterThanOrEqual(8);
  });

  it("locks down a table that a later migration adds without policies", async () => {
    // What happens when a chunk forgets policies: nobody but the owner can reach the table.
    await query(sql`create table public.forgotten (id uuid primary key, business_id uuid)`);
    await query(sql`grant all on public.forgotten to authenticated, anon`);
    await migrateDatabase({ url: target.url });

    const state = await query(sql`
      select relrowsecurity as enabled, relforcerowsecurity as forced
        from pg_class where oid = 'public.forgotten'::regclass`);
    expect(state[0]).toEqual({ enabled: true, forced: true });
    const grants = await query(sql`
      select grantee from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'forgotten'
         and grantee in ('authenticated', 'app_system', 'anon', 'PUBLIC')`);
    expect(grants).toEqual([]);

    const doctor = await runDoctor({ url: target.url, keyring: null });
    expect(doctor.find((check) => check.name === "Row-level security on every table")?.ok).toBe(
      false,
    );
    await query(sql`drop table public.forgotten`);
  });

  it("mirrors auth users into profiles and deletes profiles with them", async () => {
    await query(sql`insert into auth.users (id, email, raw_user_meta_data)
      values ('5b8f1c1e-7a44-4d0a-9d6c-3f2a1b0c9d8e', 'Pat@Example.com', '{"full_name":"Pat"}')`);
    expect(await query(sql`select email, full_name from public.users`)).toEqual([
      { email: "Pat@Example.com", full_name: "Pat" },
    ]);
    await query(sql`update auth.users set email = 'pat@example.com'`);
    expect(await query(sql`select email from public.users`)).toEqual([
      { email: "pat@example.com" },
    ]);
    await query(sql`delete from auth.users`);
    expect(await query(sql`select count(*)::int as n from public.users`)).toEqual([{ n: 0 }]);
  });
});

describe("schema and migrations", () => {
  it("are in step: the Drizzle schema generates no further migration", async () => {
    const journal = JSON.parse(
      readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
    ) as { entries: { idx: number }[] };
    const last = journal.entries.at(-1);
    const snapshot = JSON.parse(
      readFileSync(
        path.join(MIGRATIONS_FOLDER, "meta", `${String(last?.idx).padStart(4, "0")}_snapshot.json`),
        "utf8",
      ),
    ) as Parameters<typeof generateMigration>[0];
    const current = generateDrizzleJson(tables, snapshot.id);
    const statements = await generateMigration(snapshot, current);
    // A failure here means src/schema changed without `pnpm db:generate`.
    expect(statements).toEqual([]);
  });
});
