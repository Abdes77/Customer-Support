import { readFileSync } from "node:fs";
import path from "node:path";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PlaybookDocument, type SegmentId } from "@repo/core";

import { PG_ERROR, pgErrorCode } from "./errors";
import { MIGRATIONS_FOLDER } from "./migrate";
import { playbookVersions, segments } from "./schema/tables";
import { createTestDatabase, createWorld, type TestDatabase, type World } from "./testing";

/*
 * Migration 0006: stored playbook versions never change (C1 review), a signed-in author
 * cannot write under another name, and price norms stored as free text were converted.
 */

let t: TestDatabase;
let world: World;

beforeAll(async () => {
  t = await createTestDatabase();
  world = await createWorld(t);
});

afterAll(async () => {
  await t?.dispose();
});

const DOCUMENT: PlaybookDocument = {
  commonJobs: [{ name: "Repair", scope: "Fix what is broken." }],
  customerLanguage: [],
  urgencySignals: [],
  qualificationQuestions: [],
  objections: [],
  seasonalPatterns: [],
  priceNorms: [],
  permitsAndRegulations: [],
  vocabulary: [],
  sources: [],
};

async function newSegment(slug: string): Promise<SegmentId> {
  const [segment] = await t.admin
    .insert(segments)
    .values({ agencyId: world.agencies.a.agencyId, slug, name: slug })
    .returning({ id: segments.id });
  return segment!.id;
}

async function codeOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return "ok";
  } catch (error) {
    return pgErrorCode(error);
  }
}

describe("playbook versions are immutable", () => {
  it("lets staff add a version and flip the active flag, and nothing else", async () => {
    const segmentId = await newSegment("immutable-staff");
    const { aMember, aAdmin } = world.users;
    const agencyId = world.agencies.a.agencyId;

    const id = await t.db.asUser(aMember).run(async (ctx) => {
      const [row] = await ctx.tx
        .insert(playbookVersions)
        // The author named in the row is somebody else: the trigger records the real one.
        .values({ agencyId, segmentId, version: 1, document: DOCUMENT, createdBy: aAdmin.id })
        .returning({ id: playbookVersions.id, createdBy: playbookVersions.createdBy });
      expect(row?.createdBy).toBe(aMember.id);
      return row!.id;
    });

    const asMember = (set: Partial<typeof playbookVersions.$inferInsert>) =>
      codeOf(() =>
        t.db
          .asUser(aMember)
          .run((ctx) =>
            ctx.tx.update(playbookVersions).set(set).where(eq(playbookVersions.id, id)),
          ),
      );
    expect(await asMember({ isActive: true })).toBe("ok");
    expect(await asMember({ isActive: false })).toBe("ok");
    expect(await asMember({ changeNote: "Edited in place" })).toBe(PG_ERROR.restrictViolation);
    expect(
      await asMember({ document: { ...DOCUMENT, seasonalPatterns: ["Busy in spring"] } }),
    ).toBe(PG_ERROR.restrictViolation);
    expect(await asMember({ version: 7 })).toBe(PG_ERROR.restrictViolation);
    expect(await asMember({ origin: "generated" })).toBe(PG_ERROR.restrictViolation);
    // Nor can a signed-in user erase the author.
    expect(await asMember({ createdBy: null })).toBe(PG_ERROR.restrictViolation);

    const [stored] = await t.admin
      .select()
      .from(playbookVersions)
      .where(eq(playbookVersions.id, id));
    expect(stored).toMatchObject({ version: 1, changeNote: null, origin: "manual" });
    expect(stored?.document).toEqual(DOCUMENT);
  });

  it("holds on the system scope and on the unrestricted connection too", async () => {
    const segmentId = await newSegment("immutable-system");
    const agencyId = world.agencies.a.agencyId;
    const [row] = await t.admin
      .insert(playbookVersions)
      .values({
        agencyId,
        segmentId,
        version: 1,
        document: DOCUMENT,
        createdBy: world.users.aAdmin.id,
      })
      .returning({ id: playbookVersions.id, createdBy: playbookVersions.createdBy });
    // Not a signed-in user: the author is whoever the job or the script named.
    expect(row?.createdBy).toBe(world.users.aAdmin.id);
    const id = row!.id;

    const system = await codeOf(() =>
      t.db
        .forAgency(agencyId)
        .run((ctx) =>
          ctx.tx
            .update(playbookVersions)
            .set({ changeNote: "from a job" })
            .where(eq(playbookVersions.id, id)),
        ),
    );
    expect(system).toBe(PG_ERROR.restrictViolation);
    const admin = await codeOf(() =>
      t.admin
        .update(playbookVersions)
        .set({ document: { ...DOCUMENT, vocabulary: [{ term: "x", definition: "y" }] } })
        .where(eq(playbookVersions.id, id)),
    );
    expect(admin).toBe(PG_ERROR.restrictViolation);

    // Activating is the one change a job makes.
    await t.db
      .forAgency(agencyId)
      .run((ctx) =>
        ctx.tx.update(playbookVersions).set({ isActive: true }).where(eq(playbookVersions.id, id)),
      );
    const [stored] = await t.admin
      .select({ isActive: playbookVersions.isActive, changeNote: playbookVersions.changeNote })
      .from(playbookVersions)
      .where(eq(playbookVersions.id, id));
    expect(stored).toEqual({ isActive: true, changeNote: null });
  });

  it("forgets the author when that user is deleted, and changes nothing else", async () => {
    const segmentId = await newSegment("immutable-author-deleted");
    const author = await t.db.localAuth.upsertUser({ email: "leaving-author@world.test" });
    const [row] = await t.admin
      .insert(playbookVersions)
      .values({
        agencyId: world.agencies.a.agencyId,
        segmentId,
        version: 1,
        document: DOCUMENT,
        createdBy: author.id,
      })
      .returning({ id: playbookVersions.id });
    await t.admin.execute(sql`delete from auth.users where id = ${author.id}`);
    const [stored] = await t.admin
      .select({ createdBy: playbookVersions.createdBy, document: playbookVersions.document })
      .from(playbookVersions)
      .where(eq(playbookVersions.id, row!.id));
    expect(stored).toEqual({ createdBy: null, document: DOCUMENT });
  });

  it("no signed-in user deletes a version; versions go with their segment", async () => {
    const segmentId = await newSegment("immutable-delete");
    const agencyId = world.agencies.a.agencyId;
    await t.admin
      .insert(playbookVersions)
      .values({ agencyId, segmentId, version: 1, document: DOCUMENT });
    const where = and(eq(playbookVersions.segmentId, segmentId), eq(playbookVersions.version, 1));
    const asAdmin = await codeOf(() =>
      t.db.asUser(world.users.aAdmin).run((ctx) => ctx.tx.delete(playbookVersions).where(where)),
    );
    expect(asAdmin).toBe(PG_ERROR.insufficientPrivilege);
    expect(await t.admin.select().from(playbookVersions).where(where)).toHaveLength(1);

    await t.db
      .asUser(world.users.aAdmin)
      .run((ctx) => ctx.tx.delete(segments).where(eq(segments.id, segmentId)));
    expect(await t.admin.select().from(playbookVersions).where(where)).toHaveLength(0);
  });
});

describe("price norms stored as free text (before migration 0006)", () => {
  it("become numbers when the range is plain, and are dropped when it is not", async () => {
    const segmentId = await newSegment("legacy-prices");
    const agencyId = world.agencies.a.agencyId;
    const legacy = {
      ...DOCUMENT,
      priceNorms: [
        { job: "Leak repair", range: "$400 to $1,500", notes: "Depends on access." },
        { job: "Diagnostic visit", range: "$89-$149.50", notes: null },
        { job: "New roof", range: "$9-22k", notes: null },
        { job: "Gutters", range: "ask the team", notes: null },
      ],
    };
    const [row] = await t.admin
      .insert(playbookVersions)
      .values({ agencyId, segmentId, version: 1, document: legacy as never })
      .returning({ id: playbookVersions.id });

    const conversion = readFileSync(
      path.join(MIGRATIONS_FOLDER, "0006_playbook_version_guard.sql"),
      "utf8",
    ).split("--> statement-breakpoint")[0]!;
    expect(conversion).toContain("UPDATE public.playbook_versions");
    // The migration converts before it creates the trigger; here the trigger exists already.
    await t.admin.execute(
      sql`alter table public.playbook_versions disable trigger playbook_versions_immutable`,
    );
    try {
      await t.admin.execute(sql.raw(conversion));
      // Running it again changes nothing.
      await t.admin.execute(sql.raw(conversion));
    } finally {
      await t.admin.execute(
        sql`alter table public.playbook_versions enable trigger playbook_versions_immutable`,
      );
    }

    const [stored] = await t.admin
      .select({ document: playbookVersions.document })
      .from(playbookVersions)
      .where(eq(playbookVersions.id, row!.id));
    expect(stored?.document.priceNorms).toEqual([
      {
        job: "Leak repair",
        lowUsd: 400,
        highUsd: 1500,
        unit: "per job",
        region: "not stated",
        notes: "Depends on access.",
      },
      {
        job: "Diagnostic visit",
        lowUsd: 89,
        highUsd: 149.5,
        unit: "per job",
        region: "not stated",
        notes: null,
      },
    ]);
    expect(PlaybookDocument.safeParse(stored?.document).success).toBe(true);
  });
});
