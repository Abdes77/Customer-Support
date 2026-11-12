import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { scriptedRefusal } from "@repo/ai/testing";
import { type BusinessProfile, type SegmentId, TenantAccessError } from "@repo/core";
import {
  alerts,
  auditLog,
  businesses,
  businessPlaybookOverrides,
  deadLetters,
  eq,
  modelCalls,
  playbookGenerations,
  playbookVersions,
  settingValues,
} from "@repo/db";
import { createLocalJobRunner } from "@repo/jobs";

import { PEST_CONTROL_PLAYBOOK, ROOFING_PLAYBOOK, scriptedPlaybookRun } from "../testing";
import { createKnowledgeHarness, type KnowledgeHarness, type TestAgency } from "../testing/harness";
import { completenessIssues, parsePlaybookDocument } from "./document";
import { createPlaybookGenerationJob } from "./job";
import { assignSegment, requestPlaybookGeneration, segmentSlug } from "./onboarding";
import { loadPlaybookForBusiness } from "./overrides";
import { createPlaybookService, type PlaybookService } from "./service";
import {
  GENERATION_STALE_MS,
  getActivePlaybook,
  getGeneration,
  listPlaybookVersions,
  PlaybookValidationError,
  savePlaybookVersion,
} from "./store";

/**
 * Playbooks against PostgreSQL: generation through the job, reuse for the second business
 * of a segment, immutable versions with edit, diff and rollback, per-business overrides.
 */

let h: KnowledgeHarness;
let service: PlaybookService;

beforeAll(async () => {
  h = await createKnowledgeHarness();
  h.register([
    createPlaybookGenerationJob({
      db: h.t.db,
      model: h.model,
      generator: "model",
      logger: h.logger,
      clock: h.clock,
    }),
  ]);
  service = createPlaybookService({
    db: h.t.db,
    events: h.runner,
    logger: h.logger,
    clock: h.clock,
  });
});

afterAll(async () => {
  await h?.dispose();
});

const deps = () => ({ db: h.t.db, events: h.runner, logger: h.logger, clock: h.clock });

async function versionsOf(segmentId: SegmentId) {
  return h.t.admin
    .select()
    .from(playbookVersions)
    .where(eq(playbookVersions.segmentId, segmentId))
    .orderBy(playbookVersions.version);
}

/** An agency whose roofing segment has a generated playbook (version 1). */
async function agencyWithRoofing(): Promise<{
  agency: TestAgency;
  segmentId: SegmentId;
  business: Awaited<ReturnType<TestAgency["newBusiness"]>>;
}> {
  const agency = await h.newAgency();
  const business = await agency.newBusiness();
  h.model.push(...scriptedPlaybookRun("Roofing", ROOFING_PLAYBOOK));
  const result = await assignSegment(deps(), {
    agencyId: agency.agencyId,
    businessId: business.businessId,
    segment: { name: "Roofing" },
    requestedBy: agency.admin.id,
  });
  await h.runner.idle();
  return { agency, segmentId: result.segment.id, business };
}

function profile(
  tenant: { businessId: BusinessProfile["id"]; agencyId: BusinessProfile["agencyId"] },
  segmentId: SegmentId,
  slug = "roofing",
): Pick<BusinessProfile, "id" | "segment"> {
  return { id: tenant.businessId, segment: { id: segmentId, slug, name: slug } };
}

describe("onboarding a business in a segment", () => {
  it("generates the playbook the first time, and reuses it for the second roofing business", async () => {
    const agency = await h.newAgency();
    const first = await agency.newBusiness({ name: "Summit Roofing", state: "CO" });
    const second = await agency.newBusiness({ name: "Front Range Roofing", state: "CO" });
    const before = h.model.requests.length;
    h.model.push(...scriptedPlaybookRun("Roofing", ROOFING_PLAYBOOK));

    const started = await assignSegment(deps(), {
      agencyId: agency.agencyId,
      businessId: first.businessId,
      segment: { name: "Roofing", description: "Residential roofing" },
      requestedBy: agency.admin.id,
    });
    expect(started.segmentCreated).toBe(true);
    expect(started.segment).toMatchObject({ slug: "roofing", name: "Roofing" });
    expect(started.playbook).toMatchObject({ status: "generating", started: true });
    // The C2 preset for the trade is written as segment overrides, once.
    expect(started.presetApplied).toBe("roofing");
    await h.runner.idle();

    // Four model calls: three research steps and the write.
    expect(h.model.requests.length - before).toBe(4);
    expect(h.model.remaining()).toBe(0);
    const segmentId = started.segment.id;
    const versions = await versionsOf(segmentId);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      version: 1,
      isActive: true,
      origin: "generated",
      createdBy: agency.admin.id,
      changeNote: "Generated from web research: 3 searches, 4 sources cited.",
    });
    // Complete, schema-valid, with sources.
    expect(parsePlaybookDocument(versions[0]?.document)).toEqual({
      ok: true,
      document: ROOFING_PLAYBOOK,
    });
    expect(completenessIssues(versions[0]!.document)).toEqual([]);
    expect(versions[0]?.document.sources).toHaveLength(4);

    const generationId =
      started.playbook.status === "generating" ? started.playbook.generationId : "";
    const [run] = await h.t.admin
      .select()
      .from(playbookGenerations)
      .where(eq(playbookGenerations.id, generationId));
    expect(run).toMatchObject({
      status: "succeeded",
      reason: "onboarding",
      version: 1,
      requestedBy: agency.admin.id,
      errorCode: null,
    });
    expect(run?.stats).toMatchObject({
      generator: "model",
      model: "claude-fable-5-2",
      modelCalls: 4,
      searches: 3,
      sourcesCited: 4,
      step: "done",
    });
    // The brief carried the trade and where the business works; effort came from settings.
    const firstRequest = h.model.requests[before];
    expect(firstRequest?.effort).toBe("high");
    expect(JSON.stringify(firstRequest?.messages[0])).toContain("Where the businesses work: CO");
    // Every model call is recorded under the business that was being onboarded.
    const calls = await h.t.admin
      .select()
      .from(modelCalls)
      .where(eq(modelCalls.businessId, first.businessId));
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.purpose === "playbook" && call.conversationId === null)).toBe(
      true,
    );
    expect(calls[0]?.promptVersion).toBe("playbook-v1");

    // The second roofing business: same segment, same playbook, no model call.
    const reused = await assignSegment(deps(), {
      agencyId: agency.agencyId,
      businessId: second.businessId,
      segment: { name: "  roofing " },
      requestedBy: agency.member.id,
    });
    await h.runner.idle();
    expect(reused).toMatchObject({
      segmentCreated: false,
      presetApplied: null,
      playbook: { status: "reused", version: 1 },
    });
    expect(reused.segment.id).toBe(segmentId);
    expect(h.model.requests.length - before).toBe(4);
    expect(await versionsOf(segmentId)).toHaveLength(1);
    expect(
      await h.t.admin
        .select()
        .from(playbookGenerations)
        .where(eq(playbookGenerations.segmentId, segmentId)),
    ).toHaveLength(1);

    // Both businesses now answer with it.
    for (const business of [first, second]) {
      const [row] = await h.t.admin
        .select({ segmentId: businesses.segmentId })
        .from(businesses)
        .where(eq(businesses.id, business.businessId));
      expect(row?.segmentId).toBe(segmentId);
      const snapshot = await h.t.db
        .forBusiness(business.businessId)
        .run((ctx) => loadPlaybookForBusiness(ctx, profile(business, segmentId)));
      expect(snapshot).toMatchObject({ segmentSlug: "roofing", version: 1 });
      expect(snapshot?.document).toEqual(ROOFING_PLAYBOOK);
    }

    const audit = await h.t.admin
      .select({ action: auditLog.action, summary: auditLog.summary })
      .from(auditLog)
      .where(eq(auditLog.agencyId, agency.agencyId));
    expect(audit.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(["business.segment_assigned", "playbook.save"]),
    );
    expect(audit.some((entry) => entry.summary?.includes("playbook v1 reused"))).toBe(true);
  });

  it("generates a playbook for pest control, a trade without a preset or a built-in document", async () => {
    const agency = await h.newAgency();
    const business = await agency.newBusiness({ state: "GA" });
    h.model.push(...scriptedPlaybookRun("Pest control", PEST_CONTROL_PLAYBOOK));
    const started = await assignSegment(deps(), {
      agencyId: agency.agencyId,
      businessId: business.businessId,
      segment: { name: "Pest Control" },
      requestedBy: null,
    });
    await h.runner.idle();
    expect(started.segment.slug).toBe("pest-control");
    expect(started.presetApplied).toBeNull();
    const [version] = await versionsOf(started.segment.id);
    expect(version).toMatchObject({
      version: 1,
      isActive: true,
      origin: "generated",
      createdBy: null,
    });
    expect(parsePlaybookDocument(version?.document)).toEqual({
      ok: true,
      document: PEST_CONTROL_PLAYBOOK,
    });
    expect(completenessIssues(version!.document)).toEqual([]);
    expect(version?.document.sources.length).toBeGreaterThanOrEqual(3);
  });

  it("opens one run when two businesses of a new segment are onboarded at the same time", async () => {
    const agency = await h.newAgency();
    const [a, b] = await Promise.all([agency.newBusiness(), agency.newBusiness()]);
    const before = h.model.requests.length;
    h.model.push(...scriptedPlaybookRun("Roofing", ROOFING_PLAYBOOK));
    const results = await Promise.all(
      [a, b].map((business) =>
        assignSegment(deps(), {
          agencyId: agency.agencyId,
          businessId: business.businessId,
          segment: { name: "Roofing" },
          requestedBy: agency.admin.id,
        }),
      ),
    );
    await h.runner.idle();
    const statuses = results.map((result) => result.playbook);
    expect(statuses.every((status) => status.status === "generating")).toBe(true);
    expect(
      statuses.filter((status) => status.status === "generating" && status.started),
    ).toHaveLength(1);
    expect(new Set(results.map((result) => result.segment.id)).size).toBe(1);
    expect(h.model.requests.length - before).toBe(4);
    expect(await versionsOf(results[0]!.segment.id)).toHaveLength(1);
    // The preset was applied once and not doubled.
    const overrides = await h.t.admin
      .select({ key: settingValues.key })
      .from(settingValues)
      .where(eq(settingValues.segmentId, results[0]!.segment.id));
    expect(new Set(overrides.map((row) => row.key)).size).toBe(overrides.length);
    expect(overrides.length).toBeGreaterThan(0);
  });

  it("does not re-apply the preset for later businesses, so a value an admin reset stays reset", async () => {
    const { agency, segmentId } = await agencyWithRoofing();
    await h.t.admin.delete(settingValues).where(eq(settingValues.segmentId, segmentId));
    const later = await agency.newBusiness();
    const result = await assignSegment(deps(), {
      agencyId: agency.agencyId,
      businessId: later.businessId,
      segment: { id: segmentId },
      requestedBy: agency.admin.id,
    });
    expect(result.presetApplied).toBeNull();
    expect(
      await h.t.admin.select().from(settingValues).where(eq(settingValues.segmentId, segmentId)),
    ).toHaveLength(0);
  });

  it("refuses a business of another agency and a segment of another agency", async () => {
    const { agency, segmentId } = await agencyWithRoofing();
    const other = await h.newAgency();
    const foreign = await other.newBusiness();
    await expect(
      assignSegment(deps(), {
        agencyId: agency.agencyId,
        businessId: foreign.businessId,
        segment: { name: "Roofing" },
        requestedBy: null,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      assignSegment(deps(), {
        agencyId: other.agencyId,
        businessId: foreign.businessId,
        segment: { id: segmentId },
        requestedBy: null,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      assignSegment(deps(), {
        agencyId: other.agencyId,
        businessId: foreign.businessId,
        segment: { name: "  !!! " },
        requestedBy: null,
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(segmentSlug("Kitchen & Bath Remodeling")).toBe("kitchen-and-bath-remodeling");
    expect(segmentSlug("  Électricité / HVAC  ")).toBe("electricite-hvac");
  });
});

describe("a generation run that fails", () => {
  it("is closed with the reason, a dead letter and an alert, and does not block the next run", async () => {
    const agency = await h.newAgency();
    const business = await agency.newBusiness();
    h.model.push(scriptedRefusal());
    const started = await assignSegment(deps(), {
      agencyId: agency.agencyId,
      businessId: business.businessId,
      segment: { name: "Locksmiths" },
      requestedBy: agency.admin.id,
    });
    await h.runner.idle();
    const generationId =
      started.playbook.status === "generating" ? started.playbook.generationId : "";
    const run = await h.t.db
      .forAgency(agency.agencyId)
      .run((ctx) => getGeneration(ctx, generationId));
    expect(run).toMatchObject({
      status: "failed",
      errorCode: "external_service_failed",
      version: null,
    });
    expect(run?.errorMessage).toContain("declined to write this playbook");
    expect(await versionsOf(started.segment.id)).toHaveLength(0);
    const letters = await h.t.admin
      .select()
      .from(deadLetters)
      .where(eq(deadLetters.agencyId, agency.agencyId));
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({
      source: "knowledge-playbook-generate",
      eventName: "playbook.generation_requested",
      businessId: null,
    });
    const raised = await h.t.admin
      .select({ kind: alerts.kind })
      .from(alerts)
      .where(eq(alerts.businessId, business.businessId));
    expect(raised).toEqual([{ kind: "playbook_generation_failed" }]);
    // Without a playbook the engine's built-in document is used: the loader says "none".
    expect(
      await h.t.db
        .forBusiness(business.businessId)
        .run((ctx) =>
          loadPlaybookForBusiness(ctx, profile(business, started.segment.id, "locksmiths")),
        ),
    ).toBeNull();

    // An admin tries again, and this time the model delivers.
    h.model.push(...scriptedPlaybookRun("Locksmiths", ROOFING_PLAYBOOK));
    const again = await service.regenerate(agency.admin, started.segment.id);
    expect(again.started).toBe(true);
    expect(again.generation.id).not.toBe(generationId);
    await h.runner.idle();
    expect(await versionsOf(started.segment.id)).toHaveLength(1);
  });

  it("retries a model call that failed for a passing reason, without repeating the others", async () => {
    const agency = await h.newAgency();
    const business = await agency.newBusiness();
    const before = h.model.requests.length;
    const [research1, research2, research3, write] = scriptedPlaybookRun(
      "Roofing",
      ROOFING_PLAYBOOK,
    );
    const overloaded = Object.assign(new Error("overloaded"), { retryable: true });
    h.model.push(research1!, overloaded, research2!, research3!, write!);
    const started = await assignSegment(deps(), {
      agencyId: agency.agencyId,
      businessId: business.businessId,
      segment: { name: "Roofing" },
      requestedBy: null,
    });
    await h.runner.idle();
    // Five requests: the failed second call was made again, the first was not.
    expect(h.model.requests.length - before).toBe(5);
    expect(await versionsOf(started.segment.id)).toHaveLength(1);
  });

  it("stores nothing that fails the checks, however the document got to the store", async () => {
    const { agency, segmentId } = await agencyWithRoofing();
    const thin = { ...ROOFING_PLAYBOOK, sources: [] };
    await expect(
      h.t.db.forAgency(agency.agencyId).run((ctx) =>
        savePlaybookVersion(ctx, {
          segmentId,
          document: thin,
          origin: "generated",
          requireComplete: true,
        }),
      ),
    ).rejects.toBeInstanceOf(PlaybookValidationError);
    expect(await versionsOf(segmentId)).toHaveLength(1);
  });

  it("closes a run that stopped moving, so the segment is not blocked for good", async () => {
    const agency = await h.newAgency();
    const business = await agency.newBusiness();
    // Events go nowhere: the run stays pending, as after a lost job.
    const silent = { ...deps(), events: { send: async () => undefined } };
    const lost = await assignSegment(silent, {
      agencyId: agency.agencyId,
      businessId: business.businessId,
      segment: { name: "Fencing" },
      requestedBy: null,
    });
    const segmentId = lost.segment.id;
    const joined = await requestPlaybookGeneration(silent, {
      agencyId: agency.agencyId,
      segmentId,
      requestedBy: agency.admin.id,
    });
    expect(joined.started).toBe(false);
    expect(lost.playbook.status === "generating" && joined.generation.id).toBe(
      lost.playbook.status === "generating" ? lost.playbook.generationId : "",
    );

    // Nothing has touched the run for longer than the limit.
    await h.t.admin
      .update(playbookGenerations)
      .set({ updatedAt: new Date(Date.now() - GENERATION_STALE_MS - 30_000) })
      .where(eq(playbookGenerations.segmentId, segmentId));
    const fresh = await requestPlaybookGeneration(silent, {
      agencyId: agency.agencyId,
      segmentId,
      requestedBy: agency.admin.id,
    });
    expect(fresh.started).toBe(true);
    const runs = await h.t.admin
      .select({ status: playbookGenerations.status, errorCode: playbookGenerations.errorCode })
      .from(playbookGenerations)
      .where(eq(playbookGenerations.segmentId, segmentId));
    expect(runs.map((run) => `${run.status}:${run.errorCode ?? ""}`).sort()).toEqual([
      "failed:timed_out",
      "pending:",
    ]);
  });

  it("fails the run at once when the job cannot be queued", async () => {
    const agency = await h.newAgency();
    const business = await agency.newBusiness();
    const broken = {
      ...deps(),
      events: {
        send: async () => {
          throw new Error("no job runner");
        },
      },
    };
    await expect(
      assignSegment(broken, {
        agencyId: agency.agencyId,
        businessId: business.businessId,
        segment: { name: "Paving" },
        requestedBy: null,
      }),
    ).rejects.toThrow("no job runner");
    const runs = await h.t.admin
      .select({ status: playbookGenerations.status, errorCode: playbookGenerations.errorCode })
      .from(playbookGenerations)
      .where(eq(playbookGenerations.agencyId, agency.agencyId));
    expect(runs).toEqual([{ status: "failed", errorCode: "not_queued" }]);
  });
});

describe("without a model (a developer machine)", () => {
  it("stores the built-in starter playbook, marked as such", async () => {
    const agency = await h.newAgency();
    const business = await agency.newBusiness();
    const runner = createLocalJobRunner({ logger: h.logger, retryDelayMs: () => 5 });
    runner.register([
      createPlaybookGenerationJob({
        db: h.t.db,
        model: h.model,
        generator: "starter",
        logger: h.logger,
        clock: h.clock,
      }),
    ]);
    const before = h.model.requests.length;
    const started = await assignSegment(
      { ...deps(), events: runner },
      {
        agencyId: agency.agencyId,
        businessId: business.businessId,
        segment: { name: "HVAC" },
        requestedBy: agency.admin.id,
      },
    );
    await runner.idle();
    runner.stop();
    expect(h.model.requests.length).toBe(before);
    const [version] = await versionsOf(started.segment.id);
    expect(version).toMatchObject({ version: 1, isActive: true, origin: "starter" });
    expect(version?.changeNote).toContain("no model is configured");
    expect(version?.document.sources).toEqual([]);
    expect(version?.document.priceNorms).toEqual([]);
    expect(version?.document.commonJobs.length).toBeGreaterThan(0);
  });
});

describe("versions", () => {
  it("an edit is a new version; the old one is untouched; diff and rollback work", async () => {
    const { agency, segmentId } = await agencyWithRoofing();
    const edited = {
      ...ROOFING_PLAYBOOK,
      objections: [
        ...ROOFING_PLAYBOOK.objections,
        {
          objection: "Do you do free estimates?",
          response: "The team confirms how estimates work.",
        },
      ],
      seasonalPatterns: ROOFING_PLAYBOOK.seasonalPatterns.slice(0, 2),
    };

    const saved = await service.saveEdit(agency.member, {
      segmentId,
      document: edited,
      changeNote: "Added the estimate question",
      baseVersion: 1,
    });
    expect(saved).toMatchObject({
      version: 2,
      created: true,
      warnings: [],
      changedSections: ["objections", "seasonalPatterns"],
    });
    let versions = await versionsOf(segmentId);
    expect(versions.map((v) => [v.version, v.isActive, v.origin])).toEqual([
      [1, false, "generated"],
      [2, true, "manual"],
    ]);
    expect(versions[0]?.document).toEqual(ROOFING_PLAYBOOK);
    expect(versions[1]).toMatchObject({
      createdBy: agency.member.id,
      changeNote: "Added the estimate question",
    });

    // Saving the same document again stores nothing.
    expect(await service.saveEdit(agency.member, { segmentId, document: edited })).toMatchObject({
      version: 2,
      created: false,
    });
    // Someone who still has version 1 open is told so instead of overwriting version 2.
    await expect(
      service.saveEdit(agency.admin, { segmentId, document: ROOFING_PLAYBOOK, baseVersion: 1 }),
    ).rejects.toMatchObject({ code: "conflict" });
    // A document that breaks a rule is refused with the place of the problem.
    const invalid = service.saveEdit(agency.admin, {
      segmentId,
      document: { ...edited, vocabulary: [{ term: "Deductible", definition: "Usually $1,000." }] },
    });
    await expect(invalid).rejects.toBeInstanceOf(PlaybookValidationError);
    await expect(invalid).rejects.toMatchObject({
      issues: [expect.objectContaining({ path: "vocabulary[0].definition" })],
    });
    // A thin edit is allowed, with warnings.
    const thin = await service.saveEdit(agency.admin, {
      segmentId,
      document: { ...edited, priceNorms: [] },
      baseVersion: 2,
    });
    expect(thin.version).toBe(3);
    expect(thin.warnings.map((issue) => issue.section)).toEqual(["priceNorms"]);

    const diff = await service.diffVersions(agency.member, segmentId, 1, 2);
    expect(diff.changedSections).toEqual(["objections", "seasonalPatterns"]);
    expect(diff.sections.find((s) => s.section === "objections")?.added).toHaveLength(1);
    expect(diff.sections.find((s) => s.section === "seasonalPatterns")?.removed).toHaveLength(1);

    const rolled = await service.rollback(agency.admin, {
      segmentId,
      toVersion: 1,
      baseVersion: 3,
    });
    expect(rolled).toMatchObject({ version: 4, created: true });
    versions = await versionsOf(segmentId);
    expect(versions.map((v) => [v.version, v.isActive, v.origin])).toEqual([
      [1, false, "generated"],
      [2, false, "manual"],
      [3, false, "manual"],
      [4, true, "rollback"],
    ]);
    expect(versions[3]?.document).toEqual(ROOFING_PLAYBOOK);
    expect(versions[3]?.changeNote).toBe("Rolled back to version 1");
    await expect(service.rollback(agency.admin, { segmentId, toVersion: 9 })).rejects.toMatchObject(
      {
        code: "not_found",
      },
    );

    const listed = await service.listVersions(agency.member, segmentId);
    expect(listed.map((v) => v.version)).toEqual([4, 3, 2, 1]);
    expect((await service.getVersion(agency.member, segmentId))?.version).toBe(4);
    expect((await service.getVersion(agency.member, segmentId, 2))?.document).toEqual(edited);
    const segmentsOfAgency = await service.listSegments(agency.admin, agency.agencyId);
    expect(segmentsOfAgency).toHaveLength(1);
    expect(segmentsOfAgency[0]).toMatchObject({ activeVersion: 4, versions: 4, generation: null });
  });

  it("keeps version numbers gap-free and one version active under concurrent saves", async () => {
    const { agency, segmentId } = await agencyWithRoofing();
    const edits = [1, 2, 3, 4, 5].map((n) => ({
      ...ROOFING_PLAYBOOK,
      seasonalPatterns: [...ROOFING_PLAYBOOK.seasonalPatterns, `Extra pattern ${n}.`],
    }));
    const results = await Promise.all(
      edits.map((document) => service.saveEdit(agency.member, { segmentId, document })),
    );
    expect(results.map((result) => result.version).sort()).toEqual([2, 3, 4, 5, 6]);
    const versions = await versionsOf(segmentId);
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(versions.filter((v) => v.isActive)).toHaveLength(1);
  });

  it("is for agency staff of that agency only", async () => {
    const { agency, segmentId, business } = await agencyWithRoofing();
    const other = await h.newAgency();
    // Another agency's admin cannot even see that the segment exists.
    await expect(service.listVersions(other.admin, segmentId)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      service.saveEdit(other.admin, { segmentId, document: ROOFING_PLAYBOOK }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(service.regenerate(agency.outsider, segmentId)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(service.listSegments(other.admin, agency.agencyId)).rejects.toBeInstanceOf(
      TenantAccessError,
    );
    await expect(
      service.assignSegment(other.admin, {
        businessId: business.businessId,
        segment: { name: "X" },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      service.setOverride(agency.outsider, {
        businessId: business.businessId,
        section: "objections",
        content: [],
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await versionsOf(segmentId)).toHaveLength(1);
  });

  it("lets staff put a business into a segment through the service", async () => {
    const { agency, segmentId } = await agencyWithRoofing();
    const business = await agency.newBusiness();
    const result = await service.assignSegment(agency.member, {
      businessId: business.businessId,
      segment: { id: segmentId },
    });
    expect(result.playbook).toEqual({ status: "reused", version: 1 });
    expect((await service.effectivePlaybook(agency.member, business.businessId))?.version).toBe(1);
    expect(
      await h.t.db.forAgency(agency.agencyId).run((ctx) => getActivePlaybook(ctx, segmentId)),
    ).toMatchObject({ version: 1 });
    expect(
      await h.t.db.forAgency(agency.agencyId).run((ctx) => listPlaybookVersions(ctx, segmentId)),
    ).toHaveLength(1);
  });
});

describe("per-business overrides", () => {
  it("replace whole sections for one business and follow later versions for the rest", async () => {
    const { agency, segmentId, business } = await agencyWithRoofing();
    const sibling = await agency.newBusiness();
    await assignSegment(deps(), {
      agencyId: agency.agencyId,
      businessId: sibling.businessId,
      segment: { id: segmentId },
      requestedBy: null,
    });
    const ownObjections = [
      { objection: "Are you local?", response: "Yes, the crew is based in Lakewood." },
    ];
    const set = await service.setOverride(agency.member, {
      businessId: business.businessId,
      section: "objections",
      content: ownObjections,
    });
    expect(set).toMatchObject({
      section: "objections",
      baseVersion: 1,
      updatedBy: agency.member.id,
    });

    const load = (tenant: typeof business) =>
      h.t.db
        .forBusiness(tenant.businessId)
        .run((ctx) =>
          loadPlaybookForBusiness(ctx, profile(tenant, segmentId), { logger: h.logger }),
        );
    const own = await load(business);
    expect(own?.document.objections).toEqual(ownObjections);
    expect(own?.document.commonJobs).toEqual(ROOFING_PLAYBOOK.commonJobs);
    expect(own?.overriddenSections).toEqual(["objections"]);
    // The other business of the segment is not affected.
    const other = await load(sibling);
    expect(other?.document.objections).toEqual(ROOFING_PLAYBOOK.objections);
    expect(other?.overriddenSections).toBeUndefined();

    // A new segment version reaches the business everywhere except its own section.
    await service.saveEdit(agency.admin, {
      segmentId,
      document: {
        ...ROOFING_PLAYBOOK,
        seasonalPatterns: ["Busy all year.", "Slow in January."],
        objections: ROOFING_PLAYBOOK.objections.slice(0, 3),
      },
    });
    const later = await load(business);
    expect(later?.version).toBe(2);
    expect(later?.document.seasonalPatterns).toEqual(["Busy all year.", "Slow in January."]);
    expect(later?.document.objections).toEqual(ownObjections);

    // Replacing the override, and what is refused.
    await service.setOverride(agency.member, {
      businessId: business.businessId,
      section: "objections",
      content: [...ownObjections, { objection: "Insured?", response: "Yes, fully." }],
    });
    expect(
      (await service.listOverrides(agency.member, business.businessId))[0]?.content,
    ).toHaveLength(2);
    await expect(
      service.setOverride(agency.member, {
        businessId: business.businessId,
        section: "sources",
        content: [],
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      service.setOverride(agency.member, {
        businessId: business.businessId,
        section: "objections",
        content: [{ objection: "Price?", response: "Repairs start at $300." }],
      }),
    ).rejects.toBeInstanceOf(PlaybookValidationError);

    expect(
      await service.clearOverride(agency.member, {
        businessId: business.businessId,
        section: "objections",
      }),
    ).toBe(true);
    expect(
      await service.clearOverride(agency.member, {
        businessId: business.businessId,
        section: "objections",
      }),
    ).toBe(false);
    expect((await load(business))?.document.objections).toHaveLength(3);
  });

  it("ignores a stored override that does not validate instead of obeying it", async () => {
    const { segmentId, business } = await agencyWithRoofing();
    // Written behind the package's back, as agency staff can through Supabase's REST API.
    await h.t.admin.insert(businessPlaybookOverrides).values([
      { ...business, section: "priceNorms", content: [{ job: "Repair", range: "$5 to $9" }] },
      {
        ...business,
        section: "objections",
        content: [{ objection: "x", response: "Only $99 today!" }],
      },
      { ...business, section: "madeUpSection", content: ["hello"] },
      {
        ...business,
        section: "vocabulary",
        content: [{ term: "Ridge", definition: "The top edge." }],
      },
    ]);
    const snapshot = await h.t.db
      .forBusiness(business.businessId)
      .run((ctx) =>
        loadPlaybookForBusiness(ctx, profile(business, segmentId), { logger: h.logger }),
      );
    expect(snapshot?.document.priceNorms).toEqual(ROOFING_PLAYBOOK.priceNorms);
    expect(snapshot?.document.objections).toEqual(ROOFING_PLAYBOOK.objections);
    expect(snapshot?.document.vocabulary).toEqual([{ term: "Ridge", definition: "The top edge." }]);
    expect(snapshot?.overriddenSections).toEqual(["vocabulary"]);
    const warning = h.logs.find(
      (record) =>
        record.msg === "playbook.overrides_skipped" && record["businessId"] === business.businessId,
    );
    expect(warning?.["sections"]).toEqual(
      expect.arrayContaining(["priceNorms", "objections", "madeUpSection"]),
    );
  });

  it("never lets one business's override reach another tenant", async () => {
    const { business } = await agencyWithRoofing();
    const other = await agencyWithRoofing();
    await service.setOverride(other.agency.member, {
      businessId: other.business.businessId,
      section: "vocabulary",
      content: [{ term: "SECRET", definition: "Another agency's override." }],
    });
    const mine = await h.t.db.forBusiness(business.businessId).run((ctx) =>
      // Even when asked for the other business's segment and id, the scope returns nothing of theirs.
      loadPlaybookForBusiness(ctx, profile(other.business, other.segmentId)),
    );
    expect(mine).toBeNull();
  });
});

describe("a rerun when a playbook appeared in the meantime", () => {
  it("reuses it instead of generating a second first version", async () => {
    const agency = await h.newAgency();
    const business = await agency.newBusiness();
    const silent = { ...deps(), events: { send: async () => undefined } };
    const pending = await assignSegment(silent, {
      agencyId: agency.agencyId,
      businessId: business.businessId,
      segment: { name: "Roofing" },
      requestedBy: null,
    });
    const generationId =
      pending.playbook.status === "generating" ? pending.playbook.generationId : "";
    // Someone writes the playbook by hand while the run waits.
    await service.saveEdit(agency.admin, {
      segmentId: pending.segment.id,
      document: ROOFING_PLAYBOOK,
    });
    const before = h.model.requests.length;
    await h.runner.send([
      {
        name: "playbook.generation_requested",
        id: `late-${generationId}`,
        data: {
          traceId: (
            await h.t.admin
              .select({ traceId: playbookGenerations.traceId })
              .from(playbookGenerations)
              .where(eq(playbookGenerations.id, generationId))
          )[0]!.traceId,
          agencyId: agency.agencyId,
          segmentId: pending.segment.id,
          generationId,
          businessId: business.businessId,
        },
      },
    ]);
    await h.runner.idle();
    // No model call was made (the script is empty: one would have failed the run).
    expect(h.model.requests.length).toBe(before);
    const [run] = await h.t.admin
      .select()
      .from(playbookGenerations)
      .where(eq(playbookGenerations.id, generationId));
    expect(run).toMatchObject({ status: "succeeded", version: 1 });
    expect(run?.stats).toMatchObject({ reused: true });
    expect(await versionsOf(pending.segment.id)).toHaveLength(1);
  });
});
