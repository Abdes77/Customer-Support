import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createLogger } from "@repo/core";
import { type DeploymentInfo, loadEnv } from "@repo/core/env";
import {
  agencyMemberships,
  auditLog,
  businesses,
  eq,
  knowledgeItems,
  loadUserAccess,
  type UserIdentity,
} from "@repo/db";
import { createTestDatabase, createWorld, type TestDatabase, type World } from "@repo/db/testing";
import { createLocalJobRunner, type LocalJobRunner } from "@repo/jobs";

import { buildServerPipeline, type ServerPipeline } from "@/server/pipeline";

/*
 * The admin panel's server actions (C15) as the signed-in person, against a real database:
 * every action is tried by staff of another agency, client users of another business and of
 * the same business, a signed-out visitor and a cross-site request, with ids changed to
 * someone else's. Next.js itself is replaced by the smallest stand-ins (request headers, the
 * session, revalidation); everything behind the actions is the app's own composition.
 */

const local: DeploymentInfo = { environment: "local", commitSha: null, region: null };
const quiet = createLogger({ level: "error", sink: () => {} });

let t: TestDatabase;
let world: World;
let runner: LocalJobRunner;
let server: ServerPipeline;
let currentUser: UserIdentity | null = null;
const SAME_ORIGIN = {
  origin: "http://localhost:3000",
  host: "localhost:3000",
  "sec-fetch-site": "same-origin",
};
let requestHeaders = new Headers(SAME_ORIGIN);

vi.mock("next/headers", () => ({
  headers: async () => requestHeaders,
  cookies: async () => ({ get: () => undefined, getAll: () => [], set() {}, delete() {} }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`redirect ${url}`), { digest: `NEXT_REDIRECT;${url}`, url });
  },
  notFound: () => {
    throw Object.assign(new Error("not found"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  },
}));
vi.mock("@/server/auth", () => {
  const userDatabase = (user: UserIdentity) => t.db.asUser({ id: user.id, email: user.email });
  const getAccess = async () =>
    currentUser === null
      ? null
      : {
          user: currentUser,
          access: await userDatabase(currentUser).run((ctx) => loadUserAccess(ctx)),
        };
  return {
    getAccess,
    requireAccess: async () => {
      const session = await getAccess();
      if (session === null) throw new Error("signed out");
      return session;
    },
    userDatabase,
  };
});
vi.mock("@repo/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDatabase: () => t.db,
}));
vi.mock("@/server/knowledge", () => ({ getKnowledge: () => server.knowledge }));
vi.mock("@/server/handoff", () => ({ getHandoff: () => server.handoff.service }));

const actions = {
  business: () => import("./business"),
  knowledge: () => import("./knowledge"),
  playbooks: () => import("./playbooks"),
  settings: () => import("./settings"),
  alerts: () => import("./alerts"),
};

beforeAll(async () => {
  t = await createTestDatabase();
  world = await createWorld(t);
  runner = createLocalJobRunner({ logger: quiet, retryDelayMs: () => 10 });
  server = buildServerPipeline({
    db: t.db,
    env: loadEnv({}),
    deployment: local,
    logger: quiet,
    runner,
    testChannelSecret: "web-test-channel-secret-0123456789abcdef",
  });
});

afterAll(async () => {
  runner?.stop();
  await runner?.idle();
  await t?.dispose();
});

function as(user: UserIdentity | null): void {
  currentUser = user;
  requestHeaders = new Headers(SAME_ORIGIN);
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const PROFILE = {
  name: "Renamed Business",
  timezone: "America/Chicago",
  websiteUrl: "",
  phone: "",
  email: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  state: "",
  postalCode: "",
};
const EMPTY_STATE = { error: null, fieldErrors: {}, values: PROFILE };

async function businessName(id: string): Promise<string | undefined> {
  const [row] = await t.admin
    .select({ name: businesses.name })
    .from(businesses)
    .where(eq(businesses.id, id as never));
  return row?.name;
}

/** A refusal for a reason the action gave, not an unexpected failure. */
function expectRefused(result: { ok: boolean; error?: string }, label?: string): void {
  expect(result.ok, label).toBe(false);
  expect(result.error, label).not.toMatch(/Something went wrong/);
}

/** Runs an action that redirects on success; returns the redirect target or the form state. */
async function submit<S>(run: () => Promise<S>): Promise<{ redirect: string } | S> {
  try {
    return await run();
  } catch (error) {
    const url = (error as { url?: unknown }).url;
    if (typeof url === "string") return { redirect: url };
    throw error;
  }
}

describe("who may change a business", () => {
  it("refuses staff of another agency, client users and signed-out visitors", async () => {
    const { updateProfileAction, setStatusAction } = await actions.business();
    const a1 = world.businesses.a1.tenant.businessId;
    const before = await businessName(a1);
    for (const user of [
      world.users.bAdmin,
      world.users.bMember,
      world.users.b1Owner,
      world.users.a2Owner,
      world.users.a1Owner,
      world.users.a1Staff,
      world.users.outsider,
      null,
    ]) {
      as(user);
      const result = await submit(() =>
        updateProfileAction(EMPTY_STATE, form({ ...PROFILE, businessId: a1 })),
      );
      expect(result, user?.email ?? "signed out").toMatchObject({ error: expect.any(String) });
      const status = await setStatusAction({ businessId: a1, status: "paused" });
      expectRefused(status, user?.email ?? "signed out");
    }
    expect(await businessName(a1)).toBe(before);
  });

  it("lets agency staff change it, and refuses a request from another site", async () => {
    const { updateProfileAction } = await actions.business();
    const a2 = world.businesses.a2.tenant.businessId;
    as(world.users.aMember);
    requestHeaders = new Headers({
      origin: "https://evil.example",
      host: "localhost:3000",
      "sec-fetch-site": "cross-site",
    });
    const forged = await submit(() =>
      updateProfileAction(EMPTY_STATE, form({ ...PROFILE, businessId: a2 })),
    );
    expect(forged).toMatchObject({ error: expect.stringMatching(/did not come from this site/) });
    expect(await businessName(a2)).not.toBe("Renamed Business");

    as(world.users.aMember);
    const saved = await submit(() =>
      updateProfileAction(EMPTY_STATE, form({ ...PROFILE, businessId: a2 })),
    );
    expect(saved).toMatchObject({ redirect: expect.stringContaining(`/businesses/${a2}`) });
    expect(await businessName(a2)).toBe("Renamed Business");
    const audit = await t.admin
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.targetId, a2));
    expect(audit.map((row) => row.action)).toContain("business.update");
  });

  it("activates only through the finish step, which re-checks emergency readiness", async () => {
    const { setStatusAction, activateBusinessAction, createBusinessAction } =
      await actions.business();
    as(world.users.aAdmin);
    const created = await submit(() =>
      createBusinessAction(
        EMPTY_STATE,
        form({ ...PROFILE, name: "Fresh Plumbing", agencyId: world.agencies.a.agencyId }),
      ),
    );
    const id = /\/businesses\/([0-9a-f-]{36})\//.exec(
      (created as { redirect: string }).redirect,
    )![1]!;
    await t.admin
      .update(businesses)
      .set({ segmentId: world.agencies.a.segmentId })
      .where(eq(businesses.id, id as never));

    // Not through the pause/resume button, whatever the browser sends.
    const direct = await setStatusAction({ businessId: id, status: "active" });
    expect(direct).toMatchObject({ ok: false, error: expect.stringMatching(/onboarding/) });

    // Nobody can be reached in an emergency: refused without the acknowledgement.
    const refused = await activateBusinessAction({ error: null }, form({ businessId: id }));
    expect(refused.error).toMatch(/reach nobody/);
    const activated = await submit(() =>
      activateBusinessAction({ error: null }, form({ businessId: id, acknowledgeNotReady: "yes" })),
    );
    expect(activated).toMatchObject({ redirect: expect.stringContaining("activated=1") });

    // Pausing is free; resuming needs the acknowledgement again.
    expect(await setStatusAction({ businessId: id, status: "paused" })).toMatchObject({
      ok: true,
    });
    expect(await setStatusAction({ businessId: id, status: "active" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/reach nobody/),
    });
    expect(
      await setStatusAction({ businessId: id, status: "active", acknowledgeNotReady: true }),
    ).toMatchObject({ ok: true });
  });

  it("creates a business only in an agency the person is staff of", async () => {
    const { createBusinessAction } = await actions.business();
    as(world.users.aAdmin);
    const elsewhere = await submit(() =>
      createBusinessAction(
        EMPTY_STATE,
        form({ ...PROFILE, name: "Planted", agencyId: world.agencies.b.agencyId }),
      ),
    );
    expect(elsewhere).toMatchObject({ error: expect.stringMatching(/agency/) });
    as(world.users.a1Owner);
    const client = await submit(() =>
      createBusinessAction(
        EMPTY_STATE,
        form({ ...PROFILE, name: "Planted", agencyId: world.agencies.a.agencyId }),
      ),
    );
    expect(client).toMatchObject({ error: expect.any(String) });
    const planted = await t.admin
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.name, "Planted"));
    expect(planted).toHaveLength(0);
  });

  it("asks a person with two agencies which one, and uses the one named", async () => {
    const { createBusinessAction } = await actions.business();
    const twoAgencies = await t.db.localAuth.upsertUser({ email: "two-agencies@world.test" });
    await t.admin.insert(agencyMemberships).values([
      { agencyId: world.agencies.a.agencyId, userId: twoAgencies.id, role: "agency_member" },
      { agencyId: world.agencies.b.agencyId, userId: twoAgencies.id, role: "agency_admin" },
    ]);
    as({ id: twoAgencies.id, email: twoAgencies.email });
    const unnamed = await submit(() =>
      createBusinessAction(EMPTY_STATE, form({ ...PROFILE, name: "Two Agencies Co" })),
    );
    expect(unnamed).toMatchObject({ error: expect.stringMatching(/Choose the agency/) });
    const named = await submit(() =>
      createBusinessAction(
        EMPTY_STATE,
        form({ ...PROFILE, name: "Two Agencies Co", agencyId: world.agencies.b.agencyId }),
      ),
    );
    expect(named).toMatchObject({ redirect: expect.any(String) });
    const [row] = await t.admin
      .select({ agencyId: businesses.agencyId })
      .from(businesses)
      .where(eq(businesses.name, "Two Agencies Co"));
    expect(row?.agencyId).toBe(world.agencies.b.agencyId);
  });
});

describe("knowledge, playbooks and settings by someone else's ids", () => {
  it("refuses a fact of another business named through a business the person may edit", async () => {
    const { updateFactAction, factOperationAction, createFactAction } = await actions.knowledge();
    const b1 = world.businesses.b1.tenant;
    const [fact] = await t.admin
      .insert(knowledgeItems)
      .values({
        agencyId: b1.agencyId,
        businessId: b1.businessId,
        category: "services",
        title: "B1 fact",
        content: "Only for B1.",
      })
      .returning({ id: knowledgeItems.id });
    as(world.users.aAdmin);
    const a1 = world.businesses.a1.tenant.businessId;
    const update = await updateFactAction({
      businessId: a1,
      id: fact!.id,
      patch: { content: "Overwritten." },
    });
    expectRefused(update);
    const remove = await factOperationAction({ businessId: a1, id: fact!.id, operation: "remove" });
    expectRefused(remove);
    const direct = await updateFactAction({
      businessId: b1.businessId,
      id: fact!.id,
      patch: { content: "Overwritten." },
    });
    expectRefused(direct);
    const [after] = await t.admin
      .select({ content: knowledgeItems.content })
      .from(knowledgeItems)
      .where(eq(knowledgeItems.id, fact!.id));
    expect(after?.content).toBe("Only for B1.");

    // A client user of the business reads its facts but does not write them.
    as(world.users.a1Owner);
    const client = await createFactAction({
      businessId: a1,
      item: { category: "services", title: "x", content: "y", pinned: false },
    });
    expectRefused(client);
  });

  it("refuses another agency's playbook and a segment of another agency for a business", async () => {
    const { savePlaybookAction, rollbackPlaybookAction, regeneratePlaybookAction } =
      await actions.playbooks();
    const { assignSegmentAction } = await actions.business();
    const otherSegment = world.agencies.b.segmentId;
    as(world.users.aAdmin);
    expectRefused(
      await savePlaybookAction({
        segmentId: otherSegment,
        document: {},
        changeNote: "",
        baseVersion: null,
      }),
    );
    expectRefused(
      await rollbackPlaybookAction({ segmentId: otherSegment, toVersion: 1, baseVersion: null }),
    );
    expectRefused(await regeneratePlaybookAction({ segmentId: otherSegment }));
    const assign = await assignSegmentAction({
      businessId: world.businesses.a1.tenant.businessId,
      segment: { id: otherSegment },
    });
    expectRefused(assign);
    const [a1] = await t.admin
      .select({ segmentId: businesses.segmentId })
      .from(businesses)
      .where(eq(businesses.id, world.businesses.a1.tenant.businessId));
    expect(a1?.segmentId).not.toBe(otherSegment);

    as(world.users.a1Owner);
    expect((await regeneratePlaybookAction({ segmentId: world.agencies.a.segmentId })).ok).toBe(
      false,
    );
  });

  it("lets a client change only what the client portal allows, and nobody another tenant's", async () => {
    const { saveSettingAction, addSettingEntryAction } = await actions.settings();
    const a1 = { scope: "business" as const, businessId: world.businesses.a1.tenant.businessId };

    // Client owner: a client-editable setting yes (the default allows owners), a staff one no.
    as(world.users.a1Owner);
    expect(
      await saveSettingAction({
        target: a1,
        key: "persona.bot_name",
        value: "Sky",
        expectedVersion: null,
      }),
    ).toMatchObject({ ok: true });
    expectRefused(
      await saveSettingAction({
        target: a1,
        key: "persona.speaks_as",
        value: "the_business",
        expectedVersion: null,
      }),
    );
    // Client staff: not even the client-editable one (owners only by default).
    as(world.users.a1Staff);
    expectRefused(
      await saveSettingAction({
        target: a1,
        key: "persona.bot_name",
        value: "Staff",
        expectedVersion: 1,
      }),
    );
    // Another business's owner, another agency's admin, an agency-wide target of another agency.
    for (const user of [world.users.a2Owner, world.users.bAdmin]) {
      as(user);
      expectRefused(
        await saveSettingAction({
          target: a1,
          key: "persona.bot_name",
          value: "Hijack",
          expectedVersion: 1,
        }),
      );
      expectRefused(
        await addSettingEntryAction({
          target: a1,
          key: "emergency.escalation_chain",
          entry: { name: "Mallory", phone: "+15125550100", email: "", alert_by: ["sms"] },
          expectedVersion: null,
        }),
      );
    }
    as(world.users.bAdmin);
    expectRefused(
      await saveSettingAction({
        target: { scope: "global", agencyId: world.agencies.a.agencyId },
        key: "persona.bot_name",
        value: "Hijack",
        expectedVersion: null,
      }),
    );
    // An agency member may not change agency-wide values (admins only).
    as(world.users.aMember);
    expectRefused(
      await saveSettingAction({
        target: { scope: "global", agencyId: world.agencies.a.agencyId },
        key: "persona.bot_name",
        value: "Member",
        expectedVersion: null,
      }),
    );
    // A setting key that does not exist.
    expectRefused(
      await saveSettingAction({
        target: a1,
        key: "persona.no_such_setting",
        value: 1,
        expectedVersion: null,
      }),
    );
  });

  it("sends a test alert only to a contact of a list the person may change", async () => {
    const { sendTestAlertAction } = await actions.alerts();
    const a1 = { scope: "business" as const, businessId: world.businesses.a1.tenant.businessId };
    for (const user of [world.users.bAdmin, world.users.a2Owner, world.users.a1Staff, null]) {
      as(user);
      const result = await sendTestAlertAction({
        target: a1,
        key: "emergency.escalation_chain",
        index: 0,
      });
      expectRefused(result, user?.email ?? "signed out");
    }
  });
});
