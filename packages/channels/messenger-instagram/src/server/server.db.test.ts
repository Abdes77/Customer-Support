import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createGraphClient } from "@repo/channel-meta";
import { createLogger } from "@repo/core";
import {
  type BusinessTenant,
  businesses,
  channelConnections,
  channelConnectionSecrets,
  eq,
  segments,
} from "@repo/db";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";

import { MetaPageCredentials } from "../credentials";
import { createFakeMetaGraph, type FakeMetaGraph } from "../testing/fake-graph";
import {
  FIXTURE_IG_ACCOUNT_ID,
  FIXTURE_PAGE_ID,
  FIXTURE_TIME_MS,
  policyFixture,
} from "../testing/fixtures";
import { parseMetaMessagingWebhook } from "../webhook";
import { createMetaPagesService, PAGE_SUBSCRIBED_FIELDS } from "./connections";
import { createMetaPagesEventHandler, POLICY_BLOCK_PREFIX } from "./events";

const quiet = createLogger({ level: "error", sink: () => {} });
const APP = { appId: "1517776481860111", appSecret: "app-secret" };

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t?.dispose();
});

async function newBusiness(): Promise<BusinessTenant> {
  const suffix = randomUUID().slice(0, 8);
  const { id: agencyId } = await t.db.platform.createAgency({
    name: `Agency ${suffix}`,
    slug: `agency-${suffix}`,
  });
  const [segment] = await t.admin
    .insert(segments)
    .values({ agencyId, slug: "roofing", name: "Roofing" })
    .returning({ id: segments.id });
  const [business] = await t.admin
    .insert(businesses)
    .values({
      agencyId,
      segmentId: segment!.id,
      name: "Summit Roofing",
      slug: `summit-${suffix}`,
      status: "active",
    })
    .returning({ id: businesses.id });
  return { agencyId, businessId: business!.id };
}

function servicesFor(graph: FakeMetaGraph, app: typeof APP | null = APP) {
  const deps = {
    db: t.db,
    graph: createGraphClient({ fetch: graph.fetch }),
    logger: quiet,
    app,
    loginConfigId: "cfg-login",
  };
  return {
    pages: createMetaPagesService(deps),
    messengerEvents: createMetaPagesEventHandler(deps, "messenger"),
    instagramEvents: createMetaPagesEventHandler(deps, "instagram"),
  };
}

/** A fresh Page (with its Instagram account) the login grants, unique per test. */
function pageIn(graph: FakeMetaGraph, options: { instagram?: boolean; tasks?: string[] } = {}) {
  const id = String(100_000_000_000_000 + Math.floor(Math.random() * 1e12));
  const instagramId = `1784${Math.floor(Math.random() * 1e11)}`;
  graph.pages.splice(0, graph.pages.length, {
    id,
    name: "Summit Roofing",
    access_token: `EAAPage-${id}`,
    tasks: options.tasks ?? ["MESSAGING", "MODERATE"],
    ...(options.instagram === false
      ? {}
      : { instagram_business_account: { id: instagramId, username: "summitroofing" } }),
  });
  return { id, instagramId };
}

async function rowsOf(tenant: BusinessTenant) {
  return t.admin
    .select()
    .from(channelConnections)
    .where(eq(channelConnections.businessId, tenant.businessId))
    .orderBy(channelConnections.channel);
}

describe("Facebook Login for Business", () => {
  it("tells the browser what it needs, or that it is not configured", () => {
    const graph = createFakeMetaGraph();
    expect(servicesFor(graph).pages.loginConfig()).toEqual({
      appId: APP.appId,
      configId: "cfg-login",
      graphApiVersion: "v27.0",
    });
    expect(servicesFor(graph, null).pages.loginConfig()).toBeNull();
  });

  it("connects the Page and its Instagram account with the Page token encrypted", async () => {
    const graph = createFakeMetaGraph();
    const page = pageIn(graph);
    const tenant = await newBusiness();
    const result = await servicesFor(graph).pages.completeFacebookLogin(tenant, null, {
      code: "code-1",
    });
    expect(result.outcome).toBe("connected");
    const connections = result.outcome === "connected" ? result.connections : [];
    expect(connections.map((item) => [item.channel, item.status, item.pageId])).toEqual([
      ["messenger", "active", page.id],
      ["instagram", "active", page.id],
    ]);
    expect(connections[1]).toMatchObject({
      instagramAccountId: page.instagramId,
      instagramUsername: "summitroofing",
    });
    expect(JSON.stringify(result)).not.toContain("EAAPage");

    const rows = await rowsOf(tenant);
    expect(rows.map((row) => [row.channel, row.externalAccountId, row.displayName])).toEqual([
      ["instagram", page.instagramId, "@summitroofing"],
      ["messenger", page.id, "Summit Roofing"],
    ]);
    // Stored encrypted, readable only through the secret store, in the tenant's scope.
    const [raw] = await t.admin
      .select()
      .from(channelConnectionSecrets)
      .where(eq(channelConnectionSecrets.connectionId, rows[0]!.id));
    expect(JSON.stringify(raw)).not.toContain(`EAAPage-${page.id}`);
    const secret = await t.db
      .forBusiness(tenant.businessId)
      .run((ctx) => t.db.secrets.channel.read(ctx, rows[0]!.id, MetaPageCredentials));
    expect(secret).toEqual({ pageAccessToken: `EAAPage-${page.id}` });

    // The Page is subscribed to the messaging fields, with the Page's token.
    const subscribe = graph.calls.find((call) => call.path === `/${page.id}/subscribed_apps`)!;
    expect(subscribe.method).toBe("POST");
    expect(subscribe.token).toBe(`EAAPage-${page.id}`);
    expect(subscribe.url.searchParams.get("subscribed_fields")).toBe(
      PAGE_SUBSCRIBED_FIELDS.join(","),
    );
    // A system-user token does not expire: no exchange for a long-lived one.
    expect(graph.calls.filter((call) => call.path === "/oauth/access_token")).toHaveLength(1);
  });

  it("makes a short-lived user token long-lived before reading the Pages", async () => {
    const graph = createFakeMetaGraph({ expiresIn: 3600 });
    pageIn(graph);
    const tenant = await newBusiness();
    await servicesFor(graph).pages.completeFacebookLogin(tenant, null, {
      code: "code-2",
      channels: ["messenger"],
    });
    const exchanges = graph.calls.filter((call) => call.path === "/oauth/access_token");
    expect(exchanges.map((call) => call.url.searchParams.get("grant_type"))).toEqual([
      null,
      "fb_exchange_token",
    ]);
    const accounts = graph.calls.find((call) => call.path === "/me/accounts")!;
    expect(accounts.token).toBe("EAALong-lived-user-token");
    expect((await rowsOf(tenant)).map((row) => row.channel)).toEqual(["messenger"]);
  });

  it("asks which Page when the login shared several, and stores nothing until told", async () => {
    const graph = createFakeMetaGraph();
    const first = pageIn(graph);
    graph.pages.push({
      id: "200000000000001",
      name: "Summit Gutters",
      access_token: "EAAPage-gutters",
      tasks: ["ANALYZE"],
    });
    const tenant = await newBusiness();
    const { pages } = servicesFor(graph);
    const choice = await pages.completeFacebookLogin(tenant, null, { code: "code-3" });
    expect(choice).toEqual({
      outcome: "choose_page",
      pages: [
        {
          pageId: first.id,
          name: "Summit Roofing",
          instagramUsername: "summitroofing",
          hasInstagram: true,
          canMessage: true,
        },
        {
          pageId: "200000000000001",
          name: "Summit Gutters",
          instagramUsername: null,
          hasInstagram: false,
          canMessage: false,
        },
      ],
    });
    expect(await rowsOf(tenant)).toEqual([]);
    expect(graph.calls.some((call) => call.path.endsWith("/subscribed_apps"))).toBe(false);

    const connected = await pages.completeFacebookLogin(tenant, null, {
      code: "code-4",
      pageId: first.id,
    });
    expect(connected.outcome).toBe("connected");
    // A Page whose role cannot message, or one the login did not share, is refused.
    await expect(
      pages.completeFacebookLogin(tenant, null, { code: "code-5", pageId: "200000000000001" }),
    ).rejects.toThrow(/cannot send messages/);
    await expect(
      pages.completeFacebookLogin(tenant, null, { code: "code-6", pageId: "999999" }),
    ).rejects.toThrow(/not shared/);
  });

  it("refuses a Page or Instagram account of another business, before calling Meta", async () => {
    const graph = createFakeMetaGraph();
    const page = pageIn(graph);
    const owner = await newBusiness();
    await servicesFor(graph).pages.completeFacebookLogin(owner, null, { code: "code-7" });
    const intruder = await newBusiness();
    const before = graph.calls.length;
    await expect(
      servicesFor(graph).pages.completeFacebookLogin(intruder, null, {
        code: "code-8",
        pageId: page.id,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(graph.calls.length).toBe(before);
    // The Instagram account alone is refused too (found once the Pages are read).
    await expect(
      servicesFor(graph).pages.completeFacebookLogin(intruder, null, {
        code: "code-9",
        channels: ["instagram"],
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await rowsOf(intruder)).toEqual([]);
    expect((await rowsOf(owner)).every((row) => row.businessId === owner.businessId)).toBe(true);
  });

  it("keeps a Page and its Instagram account with one business, whichever was connected", async () => {
    const graph = createFakeMetaGraph();
    const page = pageIn(graph);
    const owner = await newBusiness();
    // The owner connected Messenger only; another business asks for the Instagram account.
    await servicesFor(graph).pages.completeFacebookLogin(owner, null, {
      code: "code-30",
      channels: ["messenger"],
    });
    const intruder = await newBusiness();
    const before = graph.calls.length;
    await expect(
      servicesFor(graph).pages.completeFacebookLogin(intruder, null, {
        code: "code-31",
        pageId: page.id,
        channels: ["instagram"],
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(graph.calls.length).toBe(before);

    // And the other way round: the owner has the Instagram account, not the Page.
    const second = createFakeMetaGraph();
    pageIn(second);
    const igOwner = await newBusiness();
    await servicesFor(second).pages.completeFacebookLogin(igOwner, null, {
      code: "code-32",
      channels: ["instagram"],
    });
    await expect(
      servicesFor(second).pages.completeFacebookLogin(intruder, null, {
        code: "code-33",
        channels: ["messenger"],
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await rowsOf(intruder)).toEqual([]);
    // Only the owner's login subscribed the Page.
    expect(second.calls.filter((call) => call.path.endsWith("/subscribed_apps")).length).toBe(1);
  });

  it("keeps the Page subscribed while its other connection is blocked by Meta", async () => {
    const graph = createFakeMetaGraph();
    pageIn(graph);
    const tenant = await newBusiness();
    const { pages } = servicesFor(graph);
    await pages.completeFacebookLogin(tenant, null, { code: "code-34" });
    const [instagram, messenger] = await rowsOf(tenant);
    await t.admin
      .update(channelConnections)
      .set({ status: "error", lastError: "Meta blocked messaging for this account." })
      .where(eq(channelConnections.id, messenger!.id));
    await pages.disconnect(tenant, instagram!.id);
    // The Messenger connection waits for Meta's unblock, which arrives by webhook.
    expect(graph.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("connects Messenger alone when the Page has no Instagram account", async () => {
    const graph = createFakeMetaGraph();
    pageIn(graph, { instagram: false });
    const tenant = await newBusiness();
    const result = await servicesFor(graph).pages.completeFacebookLogin(tenant, null, {
      code: "code-10",
    });
    expect(
      result.outcome === "connected" && result.connections.map((item) => item.channel),
    ).toEqual(["messenger"]);
    await expect(
      servicesFor(graph).pages.completeFacebookLogin(tenant, null, {
        code: "code-11",
        channels: ["instagram"],
      }),
    ).rejects.toThrow(/no linked Instagram/);
  });

  it("disconnects: no token left, and the app leaves the Page once nothing uses it", async () => {
    const graph = createFakeMetaGraph();
    const page = pageIn(graph);
    const tenant = await newBusiness();
    const { pages } = servicesFor(graph);
    await pages.completeFacebookLogin(tenant, null, { code: "code-12" });
    const [instagram, messenger] = await rowsOf(tenant);
    await pages.disconnect(tenant, instagram!.id);
    // Messenger still uses the Page: no unsubscribe yet.
    expect(graph.calls.some((call) => call.method === "DELETE")).toBe(false);
    await pages.disconnect(tenant, messenger!.id);
    const unsubscribe = graph.calls.filter((call) => call.method === "DELETE");
    expect(unsubscribe.map((call) => [call.path, call.token])).toEqual([
      [`/${page.id}/subscribed_apps`, `EAAPage-${page.id}`],
    ]);
    expect((await rowsOf(tenant)).map((row) => row.status)).toEqual(["disabled", "disabled"]);
    const secrets = await t.admin
      .select()
      .from(channelConnectionSecrets)
      .where(eq(channelConnectionSecrets.businessId, tenant.businessId));
    expect(secrets).toEqual([]);
    await expect(pages.disconnect(await newBusiness(), messenger!.id)).rejects.toThrow(/not found/);
    // Reconnecting brings the same rows back.
    await pages.completeFacebookLogin(tenant, null, { code: "code-13" });
    expect((await rowsOf(tenant)).map((row) => row.status)).toEqual(["active", "active"]);
  });
});

describe("policy enforcement events", () => {
  async function connected() {
    const graph = createFakeMetaGraph();
    const page = pageIn(graph);
    const tenant = await newBusiness();
    const services = servicesFor(graph);
    await services.pages.completeFacebookLogin(tenant, null, { code: "code-p" });
    // Connected "now"; the events below are from after that.
    return { graph, page, tenant, services };
  }

  const signalOf = (body: Record<string, unknown>, channel: "messenger" | "instagram") => {
    const parsed = parseMetaMessagingWebhook(JSON.stringify(body), { channel, now: new Date() });
    const signal = parsed.signals[0];
    if (signal?.type !== "provider_event") throw new Error("expected a provider event");
    return signal;
  };

  it("marks only the named connection blocked, and an unblock clears it", async () => {
    const { page, tenant, services } = await connected();
    const later = Date.now() + 60_000;
    const block = signalOf(
      policyFixture("block", { accountId: page.id, timestamp: later }),
      "messenger",
    );
    expect(await services.messengerEvents.handle(block)).toBe(true);
    let [instagram, messenger] = await rowsOf(tenant);
    expect(messenger!.status).toBe("error");
    expect(messenger!.lastError).toContain(POLICY_BLOCK_PREFIX);
    expect(instagram!.status).toBe("active");

    const unblock = signalOf(
      policyFixture("unblock", { accountId: page.id, timestamp: later + 1000 }),
      "messenger",
    );
    expect(await services.messengerEvents.handle(unblock)).toBe(true);
    [instagram, messenger] = await rowsOf(tenant);
    expect([messenger!.status, messenger!.lastError]).toEqual(["active", null]);
    expect(instagram!.status).toBe("active");
  });

  it("ignores an event from before the connection was made, and unknown accounts", async () => {
    const { page, tenant, services } = await connected();
    const stale = signalOf(
      policyFixture("block", { accountId: page.id, timestamp: FIXTURE_TIME_MS - 86_400_000 * 400 }),
      "messenger",
    );
    expect(await services.messengerEvents.handle(stale)).toBe(false);
    expect((await rowsOf(tenant)).map((row) => row.status)).toEqual(["active", "active"]);
    const unknown = signalOf(policyFixture("block", { accountId: FIXTURE_PAGE_ID }), "messenger");
    expect(await services.messengerEvents.handle(unknown)).toBe(false);
  });

  it("never lets an unblock switch on a connection that was stopped for another reason", async () => {
    const { page, tenant, services } = await connected();
    const [, messenger] = await rowsOf(tenant);
    await t.admin
      .update(channelConnections)
      .set({ status: "error", lastError: "The Page token was revoked." })
      .where(eq(channelConnections.id, messenger!.id));
    const unblock = signalOf(
      policyFixture("unblock", { accountId: page.id, timestamp: Date.now() + 60_000 }),
      "messenger",
    );
    expect(await services.messengerEvents.handle(unblock)).toBe(false);
    expect((await rowsOf(tenant))[1]!.status).toBe("error");
  });

  it("keeps a warning on the Instagram connection it names", async () => {
    const { page, tenant, services } = await connected();
    const warning = signalOf(
      policyFixture("warning", {
        channel: "instagram",
        accountId: page.instagramId,
        timestamp: Date.now() + 60_000,
      }),
      "instagram",
    );
    expect(await services.instagramEvents.handle(warning)).toBe(true);
    const [instagram, messenger] = await rowsOf(tenant);
    expect(instagram!.status).toBe("active");
    expect(instagram!.state).toMatchObject({ policy: { action: "warning" } });
    expect(messenger!.state).toEqual({});
    expect(FIXTURE_IG_ACCOUNT_ID).not.toBe(page.instagramId);
  });
});
