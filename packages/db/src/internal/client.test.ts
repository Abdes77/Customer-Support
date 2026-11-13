import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditLog } from "../schema/tables";
import { createTestDatabase, createWorld, type TestDatabase, type World } from "../testing";

let t: TestDatabase;
let world: World;

beforeAll(async () => {
  t = await createTestDatabase();
  world = await createWorld(t);
});

afterAll(async () => {
  await t?.dispose();
});

/*
 * postgres.js parses json and jsonb by default, and Drizzle's json/jsonb columns parse any
 * string they receive once more. A stored JSON string that itself looks like JSON ("55408",
 * "true", "[1,2]") then changed type on read. `connect()` leaves the parse to Drizzle alone.
 */
const VALUES: readonly unknown[] = [
  "55408",
  "true",
  "false",
  "null",
  "12.5",
  '{"a":1}',
  "[1,2]",
  '"quoted"',
  "Riley",
  "",
  "back\\slash and é",
  55408,
  0,
  true,
  false,
  { zip: "55408", nested: ["true", 1, null] },
  ["55408", "null", 3],
  [],
  {},
];

describe("json and jsonb columns", () => {
  it("read back every value with the type it was written with", async () => {
    const agencyId = world.agencies.a.agencyId;
    const action = "test.json_roundtrip";
    await t.admin.insert(auditLog).values(
      VALUES.map((value, index) => ({
        agencyId,
        actorType: "system" as const,
        action,
        targetId: String(index),
        before: value,
        after: { value },
      })),
    );

    const rows = await t.admin
      .select({ targetId: auditLog.targetId, before: auditLog.before, after: auditLog.after })
      .from(auditLog)
      .where(eq(auditLog.action, action));
    const byIndex = new Map(rows.map((row) => [Number(row.targetId), row]));

    VALUES.forEach((value, index) => {
      expect(byIndex.get(index)?.before, `value ${index}`).toStrictEqual(value);
      expect(byIndex.get(index)?.after, `value ${index}`).toStrictEqual({ value });
    });
  });

  it("does the same through a tenant context and RETURNING", async () => {
    const tenant = world.businesses.a1.tenant;
    const returned = await t.db.forBusiness(tenant.businessId).run((ctx) =>
      ctx.tx
        .insert(auditLog)
        .values({
          ...ctx.tenant,
          actorType: "system",
          action: "test.json_returning",
          before: "55408",
          after: "true",
        })
        .returning({ before: auditLog.before, after: auditLog.after }),
    );
    expect(returned).toStrictEqual([{ before: "55408", after: "true" }]);
  });

  it("returns json from raw SQL as text, for the caller to parse once", async () => {
    const rows = (await t.admin.execute(
      sql`select '"55408"'::jsonb as b, '{"a":"true"}'::json as j`,
    )) as unknown as readonly Record<string, unknown>[];
    expect(rows[0]).toStrictEqual({ b: '"55408"', j: '{"a":"true"}' });
  });
});
