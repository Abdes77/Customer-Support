import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createFakeMetaGraph,
  echoMessage,
  type EventOptions,
  type FakeMetaGraph,
  FIXTURE_APP_ID,
  FIXTURE_IG_ACCOUNT_ID,
  FIXTURE_PAGE_ID,
  inboundMessage,
  INBOUND_FIXTURES,
  deliveryFixture,
  mid,
  PAGE_INBOX_APP_ID,
  readFixture,
  signedMetaHttpRequest,
} from "@repo/channel-messenger-instagram/testing";
import {
  type AgencyId,
  type BusinessId,
  type ChannelConnectionId,
  createLogger,
  type TraceId,
  type UserId,
} from "@repo/core";
import { type DeploymentInfo, loadEnv } from "@repo/core/env";
import {
  and,
  attachments,
  businesses,
  channelConnections,
  conversations,
  eq,
  isNull,
  messages,
  segments,
  sql,
  takeoverLocks,
} from "@repo/db";
import { createTenantStorage, MemoryObjectStore } from "@repo/db/storage";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import { createLocalJobRunner, jobEvent, type LocalJobRunner } from "@repo/jobs";
import { sendEventId } from "@repo/pipeline";
import type { AppSettings } from "@repo/settings";
import { applySettingChanges } from "@repo/settings/server";

import { buildServerPipeline, type ServerPipeline } from "@/server/pipeline";
import { createWebhookHandler } from "@/server/pipeline/webhook-route";

import { createFacebookLoginHandler } from "./routes";

/*
 * Messenger and Instagram end to end, without Meta: recorded-style webhooks signed with the
 * app secret go through the real route, pipeline, jobs, engine (the offline model) and
 * adapters, which talk to a fake Graph API. The live version of this is HUMAN_TODO 13.
 */

const local: DeploymentInfo = { environment: "local", commitSha: null, region: null };
const quiet = createLogger({ level: "error", sink: () => {} });
const APP_SECRET = "meta-app-secret-for-tests";
const VERIFY_TOKEN = "verify-token-for-tests";
const PAGE_TOKEN = "EAAPage-token";

type Channel = "messenger" | "instagram";

let t: TestDatabase;
let runner: LocalJobRunner;
let server: ServerPipeline;
let graph: FakeMetaGraph;
let tenant: { agencyId: AgencyId; businessId: BusinessId };
const connectionIds: Partial<Record<Channel, ChannelConnectionId>> = {};

const handle = () => createWebhookHandler(() => server.pipeline);

async function deliver(body: unknown, channel: Channel = "messenger", secret = APP_SECRET) {
  return handle()(signedMetaHttpRequest(secret, body, channel), {
    params: Promise.resolve({ channel }),
  });
}

async function setSettings(values: Partial<AppSettings>) {
  await t.db.forBusiness(tenant.businessId).run((ctx) =>
    applySettingChanges(ctx, {
      target: { scope: "business", ...tenant },
      changes: Object.entries(values).map(([key, value]) => ({ key, value: value as never })),
      actor: { type: "system", label: "web messenger and instagram tests" },
    }),
  );
}

async function rowsFrom(customer: string) {
  const [conversation] = await t.admin
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.businessId, tenant.businessId),
        sql`${conversations.contactId} in (select contact_id from contact_identities where external_id = ${customer})`,
      ),
    )
    .limit(1);
  if (conversation === undefined) return { conversationId: null, rows: [] };
  const rows = await t.admin
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversation.id))
    .orderBy(messages.sequence);
  return { conversationId: conversation.id, rows };
}

/** A customer id unique to the test, so conversations never mix. */
const customer = () => String(7_000_000_000_000_000 + Math.floor(Math.random() * 1e15));

beforeAll(async () => {
  t = await createTestDatabase();
  graph = createFakeMetaGraph();
  runner = createLocalJobRunner({ logger: quiet, debouncePeriodMs: 50, retryDelayMs: () => 10 });
  const store = new MemoryObjectStore();
  server = buildServerPipeline({
    db: t.db,
    env: loadEnv({
      META_APP_ID: FIXTURE_APP_ID,
      META_APP_SECRET: APP_SECRET,
      META_WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
      META_LOGIN_CONFIG_ID: "555555555",
    }),
    deployment: local,
    logger: quiet,
    runner,
    testChannelSecret: "web-test-channel-secret-0123456789",
    storage: (owner) => createTenantStorage(store, owner),
    metaFetch: graph.fetch,
  });
  const { id: agencyId } = await t.db.platform.createAgency({ name: "Agency", slug: "agency" });
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
      slug: "summit",
      status: "active",
    })
    .returning({ id: businesses.id });
  tenant = { agencyId, businessId: business!.id };
  // The Page and its Instagram account as Facebook Login leaves them.
  const config = {
    pageId: FIXTURE_PAGE_ID,
    pageName: "Summit Roofing",
    instagramAccountId: FIXTURE_IG_ACCOUNT_ID,
    instagramUsername: "summitroofing",
  };
  for (const [channel, externalAccountId] of [
    ["messenger", FIXTURE_PAGE_ID],
    ["instagram", FIXTURE_IG_ACCOUNT_ID],
  ] as const) {
    const [connection] = await t.admin
      .insert(channelConnections)
      .values({ ...tenant, channel, externalAccountId, status: "active", config })
      .returning({ id: channelConnections.id });
    connectionIds[channel] = connection!.id;
    await t.db
      .forBusiness(tenant.businessId)
      .run((ctx) =>
        t.db.secrets.channel.write(ctx, connection!.id, { pageAccessToken: PAGE_TOKEN }),
      );
  }
  await setSettings({
    "conversation.reply_wait_seconds.messenger": 0,
    "conversation.reply_wait_seconds.instagram": 0,
  });
});

afterAll(async () => {
  runner?.stop();
  await runner?.idle();
  await t?.dispose();
});

describe("POST /api/webhooks/messenger and /instagram", () => {
  it("answers Meta's handshake and refuses a bad signature before anything is stored (I1)", async () => {
    for (const channel of ["messenger", "instagram"] as const) {
      const url = `http://localhost:3000/api/webhooks/${channel}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=8462`;
      const response = await handle()(new Request(url), { params: Promise.resolve({ channel }) });
      expect(await response.text()).toBe("8462");
      const from = customer();
      const forged = await deliver(
        INBOUND_FIXTURES.text("forged", { channel, from }),
        channel,
        "not-the-app-secret",
      );
      expect(forged.status).toBe(401);
      expect((await rowsFrom(from)).rows).toEqual([]);
    }
  });

  it("round-trips a Messenger conversation: stored once, answered, delivered and read", async () => {
    const from = customer();
    const body = INBOUND_FIXTURES.text("Hi, my roof is leaking over the kitchen", { from });
    const first = await deliver(body);
    expect(await first.json()).toMatchObject({ ok: true, stored: 1, emitted: 1 });
    // Meta redelivers: stored once (I2).
    expect(await (await deliver(body)).json()).toMatchObject({ stored: 0, duplicates: 1 });
    await runner.idle();

    const { rows } = await rowsFrom(from);
    const replies = rows.filter((row) => row.direction === "outbound");
    expect(replies.length).toBeGreaterThan(0);
    expect(replies.every((row) => row.status === "sent" && row.author === "bot")).toBe(true);
    const sent = graph.sent().filter((item) => (item["recipient"] as { id: string }).id === from);
    expect(sent.map((item) => (item["message"] as { text: string }).text)).toEqual(
      replies.map((row) => row.text),
    );
    expect(sent[0]).toMatchObject({ messaging_type: "RESPONSE" });
    expect(sent[0]!["tag"]).toBeUndefined();
    // Seen and typing, as sender actions, with the Page's token on the Page's endpoint.
    expect(graph.actions()).toContainEqual({ recipient: { id: from }, sender_action: "mark_seen" });
    expect(graph.actions()).toContainEqual({ recipient: { id: from }, sender_action: "typing_on" });
    expect(
      graph.calls
        .filter((call) => call.path.endsWith("/messages"))
        .every((call) => call.token === PAGE_TOKEN && call.path === `/${FIXTURE_PAGE_ID}/messages`),
    ).toBe(true);

    // Our own echo is not a person replying.
    const reply = replies[0]!;
    await deliver(
      echoMessage(
        { mid: reply.externalMessageId!, text: reply.text!, app_id: FIXTURE_APP_ID },
        { from },
      ),
    );
    // Deliveries by id, then a read watermark.
    const delivered = await deliver(
      deliveryFixture([reply.externalMessageId!], Date.now(), { from }),
    );
    expect(await delivered.json()).toMatchObject({ statuses: 1 });
    await deliver(readFixture({ watermark: Date.now() + 1000 }, { from }));
    const after = (await rowsFrom(from)).rows;
    expect(after.filter((row) => row.author === "human_agent")).toEqual([]);
    expect(after.find((row) => row.id === reply.id)!.status).toBe("read");
  });

  it("round-trips Instagram through the linked Page, and its echo is matched to the bot", async () => {
    const from = customer();
    const options: EventOptions = { channel: "instagram", from };
    await deliver(INBOUND_FIXTURES.text("Do you fix hail damage?", options), "instagram");
    await runner.idle();
    const { rows, conversationId } = await rowsFrom(from);
    const reply = rows.find((row) => row.direction === "outbound")!;
    expect(reply).toMatchObject({
      status: "sent",
      author: "bot",
      channelConnectionId: connectionIds.instagram,
    });
    const sent = graph.sent().filter((item) => (item["recipient"] as { id: string }).id === from);
    expect(sent.length).toBeGreaterThan(0);
    expect(
      graph.calls
        .filter(
          (call) =>
            call.path.endsWith("/messages") &&
            (call.json as { recipient: { id: string } }).recipient.id === from,
        )
        .every((call) => call.path === `/${FIXTURE_PAGE_ID}/messages`),
    ).toBe(true);

    // Instagram's echo of the bot's words has no app id and an id we may not know yet.
    await deliver(echoMessage({ mid: mid("aWdf"), text: reply.text! }, options), "instagram");
    expect(
      await t.admin
        .select()
        .from(takeoverLocks)
        .where(eq(takeoverLocks.conversationId, conversationId!)),
    ).toEqual([]);
    // Seen, by message id.
    expect(
      await (
        await deliver(readFixture({ mid: reply.externalMessageId! }, options), "instagram")
      ).json(),
    ).toMatchObject({ statuses: 1 });
    expect((await rowsFrom(from)).rows.find((row) => row.id === reply.id)!.status).toBe("read");
  });

  it("stores and answers a message delivered twice at once only once (I2)", async () => {
    const from = customer();
    const body = INBOUND_FIXTURES.text("Twice at once", { from });
    const results = await Promise.all([deliver(body), deliver(body)]);
    expect(results.map((response) => response.status)).toEqual([200, 200]);
    await runner.idle();
    const { rows } = await rowsFrom(from);
    expect(rows.filter((row) => row.direction === "inbound")).toHaveLength(1);
    const turns = rows.filter((row) => row.direction === "outbound");
    expect(turns.length).toBeGreaterThan(0);
    expect(new Set(turns.map((row) => row.sequence)).size).toBe(turns.length);
    const sentTexts = graph
      .sent()
      .filter((item) => (item["recipient"] as { id: string }).id === from)
      .map((item) => (item["message"] as { text: string }).text);
    expect(sentTexts).toEqual(turns.map((row) => row.text));
  });

  it("downloads a photo from Meta's CDN without a token and stores it", async () => {
    const from = customer();
    const body = INBOUND_FIXTURES.image({ from });
    await deliver(body);
    await runner.idle();
    const { rows } = await rowsFrom(from);
    const inbound = rows.find((row) => row.direction === "inbound")!;
    const [stored] = await t.admin
      .select()
      .from(attachments)
      .where(eq(attachments.messageId, inbound.id));
    expect(stored).toMatchObject({ status: "stored", kind: "image" });
    const download = graph.calls.find((call) => call.url.hostname === "scontent.xx.fbcdn.net")!;
    expect(download.token).toBeNull();
  });
});

describe("hand-over when a person replies in Meta's inbox", () => {
  it("records the person's reply, pauses the bot, and keeps it paused (I5)", async () => {
    // A longer wait, so the person answers before the bot would.
    await setSettings({ "conversation.reply_wait_seconds.messenger": 2 });
    const from = customer();
    await deliver(INBOUND_FIXTURES.text("Can someone call me?", { from }));
    const inbox = mid();
    const response = await deliver(
      echoMessage(
        { mid: inbox, text: "Hi, Sam from Summit here. Calling now.", app_id: PAGE_INBOX_APP_ID },
        { from },
      ),
    );
    expect(await response.json()).toMatchObject({ signals: 1 });
    // Meta delivers the echo again: one stored reply, one takeover.
    await deliver(
      echoMessage(
        { mid: inbox, text: "Hi, Sam from Summit here. Calling now.", app_id: PAGE_INBOX_APP_ID },
        { from },
      ),
    );
    await runner.idle();
    const { rows, conversationId } = await rowsFrom(from);
    expect(rows.filter((row) => row.author === "human_agent").map((row) => row.text)).toEqual([
      "Hi, Sam from Summit here. Calling now.",
    ]);
    const locks = await t.admin
      .select()
      .from(takeoverLocks)
      .where(
        and(eq(takeoverLocks.conversationId, conversationId!), isNull(takeoverLocks.releasedAt)),
      );
    expect(locks.map((lock) => lock.source)).toEqual(["provider_inbox"]);
    // The bot never answered: the person did.
    expect(rows.filter((row) => row.author === "bot")).toEqual([]);

    // The customer writes again: stored, not answered by the bot while the person holds it.
    await deliver(INBOUND_FIXTURES.text("Thanks! I'm home all day", { from }));
    await runner.idle();
    const later = (await rowsFrom(from)).rows;
    expect(later.filter((row) => row.direction === "inbound")).toHaveLength(2);
    expect(later.filter((row) => row.author === "bot")).toEqual([]);
    expect(
      graph.sent().filter((item) => (item["recipient"] as { id: string }).id === from),
    ).toEqual([]);
    await setSettings({ "conversation.reply_wait_seconds.messenger": 0 });
  });

  it("hands over on an Instagram reply the bot never wrote", async () => {
    const from = customer();
    const options: EventOptions = { channel: "instagram", from };
    await deliver(INBOUND_FIXTURES.text("Hello", options), "instagram");
    await runner.idle();
    await deliver(
      echoMessage({ mid: mid("aWdf"), text: "This is Jo, I'll DM you a quote today" }, options),
      "instagram",
    );
    const { rows, conversationId } = await rowsFrom(from);
    expect(rows.filter((row) => row.author === "human_agent").map((row) => row.text)).toEqual([
      "This is Jo, I'll DM you a quote today",
    ]);
    const locks = await t.admin
      .select()
      .from(takeoverLocks)
      .where(
        and(eq(takeoverLocks.conversationId, conversationId!), isNull(takeoverLocks.releasedAt)),
      );
    expect(locks).toHaveLength(1);
  });
});

describe("messaging windows and the human-agent tag (I6)", () => {
  /** A conversation whose customer last wrote `hoursAgo` hours ago, and a queued message. */
  async function queuedAfter(
    hoursAgo: number,
    author: "bot" | "human_agent",
    channel: Channel = "messenger",
    beforeSend?: () => void,
  ) {
    const from = customer();
    const options: EventOptions = { channel, from };
    // A takeover by a person would withhold a bot message; this customer just went quiet.
    await deliver(INBOUND_FIXTURES.text("Thanks", options), channel);
    await runner.idle();
    const { conversationId } = await rowsFrom(from);
    await t.admin
      .update(conversations)
      .set({ lastInboundAt: new Date(Date.now() - hoursAgo * 3600 * 1000) })
      .where(eq(conversations.id, conversationId!));
    const [counter] = await t.admin
      .update(conversations)
      .set({ messageSeq: sql`${conversations.messageSeq} + 1` })
      .where(eq(conversations.id, conversationId!))
      .returning({ sequence: conversations.messageSeq });
    const [queued] = await t.admin
      .insert(messages)
      .values({
        ...tenant,
        conversationId: conversationId!,
        channelConnectionId: connectionIds[channel]!,
        direction: "outbound",
        author,
        kind: "text",
        text:
          author === "bot"
            ? "Did you still want that inspection?"
            : "Sorry for the delay, Sam here.",
        payload: {},
        sequence: counter!.sequence,
        status: "queued",
      })
      .returning({ id: messages.id });
    const sentBefore = graph.sent().length;
    beforeSend?.();
    await server.events.send([
      jobEvent("message.send_requested", sendEventId(queued!.id), {
        traceId: randomUUID() as TraceId,
        ...tenant,
        conversationId: conversationId!,
        messageId: queued!.id,
        channel,
      }),
    ]);
    await runner.idle();
    const [row] = await t.admin.select().from(messages).where(eq(messages.id, queued!.id));
    return { row: row!, sent: graph.sent().slice(sentBefore) };
  }

  it("never sends the bot's message after 24 hours", async () => {
    for (const channel of ["messenger", "instagram"] as const) {
      const { row, sent } = await queuedAfter(25, "bot", channel);
      expect([row.status, row.errorCode]).toEqual(["failed", "window_closed"]);
      expect(sent).toEqual([]);
    }
  });

  it("sends a person's reply inside 24 hours as a plain response", async () => {
    const { row, sent } = await queuedAfter(2, "human_agent");
    expect(row.status).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ messaging_type: "RESPONSE" });
    expect(sent[0]!["tag"]).toBeUndefined();
  });

  it("tags a person's reply between 24 hours and 7 days with HUMAN_AGENT", async () => {
    for (const channel of ["messenger", "instagram"] as const) {
      const { row, sent } = await queuedAfter(30, "human_agent", channel);
      expect(row.status).toBe("sent");
      expect(sent).toEqual([
        expect.objectContaining({
          messaging_type: "MESSAGE_TAG",
          tag: "HUMAN_AGENT",
          message: expect.objectContaining({ text: "Sorry for the delay, Sam here." }),
        }),
      ]);
    }
  });

  it("refuses a person's reply after 7 days", async () => {
    const { row, sent } = await queuedAfter(24 * 7 + 1, "human_agent");
    expect([row.status, row.errorCode]).toEqual(["failed", "window_closed"]);
    expect(sent).toEqual([]);
  });

  it("fails for good when Meta says the window is closed", async () => {
    // Inside our window, but Meta disagrees (its clock, or a Page restriction).
    const { row, sent } = await queuedAfter(2, "bot", "messenger", () =>
      graph.failNext(/\/messages$/, { code: 10, subcode: 2018278 }),
    );
    expect([row.status, row.errorCode]).toEqual(["failed", "window_closed"]);
    expect(sent).toEqual([]);
  });
});

describe("what the bot leaves to the team", () => {
  it("leaves Instagram story replies alone when the setting says so", async () => {
    await setSettings({ "channels.instagram.story_replies": "ignore" });
    const from = customer();
    const options: EventOptions = { channel: "instagram", from };
    await deliver(INBOUND_FIXTURES.storyReply(options), "instagram");
    await runner.idle();
    let rows = (await rowsFrom(from)).rows;
    expect(rows.map((row) => [row.direction, row.kind])).toEqual([["inbound", "story_reply"]]);
    // A real question afterwards is answered.
    await deliver(INBOUND_FIXTURES.text("Also, do you do gutters?", options), "instagram");
    await runner.idle();
    rows = (await rowsFrom(from)).rows;
    expect(rows.some((row) => row.author === "bot")).toBe(true);

    await setSettings({ "channels.instagram.story_replies": "reply" });
    const other = customer();
    await deliver(INBOUND_FIXTURES.storyReply({ channel: "instagram", from: other }), "instagram");
    await runner.idle();
    expect((await rowsFrom(other)).rows.some((row) => row.author === "bot")).toBe(true);
  });

  it("stays quiet while another app controls the conversation (standby)", async () => {
    const from = customer();
    await deliver(inboundMessage({ mid: mid(), text: "Hello?" }, { from, standby: true }));
    await runner.idle();
    const { rows } = await rowsFrom(from);
    expect(rows.map((row) => [row.direction, row.text])).toEqual([["inbound", "Hello?"]]);
  });
});

describe("POST /api/oauth/meta/facebook (Facebook Login)", () => {
  async function user(email: string): Promise<UserId> {
    const created = await t.db.localAuth.upsertUser({ email, fullName: email });
    return created.id;
  }

  function post(body: unknown, headers: Record<string, string> = {}) {
    return new Request("http://localhost:3000/api/oauth/meta/facebook", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000", ...headers },
      body: JSON.stringify(body),
    });
  }

  it("connects a Page for agency staff, asks which Page when several, and refuses everyone else", async () => {
    const adminId = await user(`admin-${randomUUID()}@example.com`);
    const { id: agencyId } = await t.db.platform.createAgency({
      name: "Agency B",
      slug: `agency-b-${randomUUID().slice(0, 6)}`,
    });
    const [segment] = await t.admin
      .insert(segments)
      .values({ agencyId, slug: "hvac", name: "HVAC" })
      .returning({ id: segments.id });
    const [business] = await t.admin
      .insert(businesses)
      .values({
        agencyId,
        segmentId: segment!.id,
        name: "Cool Air",
        slug: "cool-air",
        status: "active",
      })
      .returning({ id: businesses.id });
    graph.pages.splice(0, graph.pages.length, {
      id: "300000000000001",
      name: "Cool Air",
      access_token: "EAAPage-cool-air",
      tasks: ["MESSAGING"],
      instagram_business_account: { id: "17841400000000001", username: "coolair" },
    });
    const access = (role: "agency_admin" | "client_owner") => async () => ({
      user: { id: adminId, email: null },
      access: {
        userId: adminId,
        agencies: role === "agency_admin" ? [{ agencyId, role }] : [],
        businesses:
          role === "client_owner"
            ? [{ businessId: business!.id, agencyId, role, enabled: true }]
            : [],
      },
    });
    const handler = (getAccess: ReturnType<typeof access> | (() => Promise<null>)) =>
      createFacebookLoginHandler({
        getAccess,
        getMetaPages: () => server.metaPages,
        directory: t.db.directory,
        logger: quiet,
      });
    const asAdmin = handler(access("agency_admin"));
    const body = { businessId: business!.id, code: "code-from-login" };

    const response = await asAdmin(post(body));
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      outcome: string;
      connections: { channel: string }[];
    };
    expect(result.outcome).toBe("connected");
    expect(result.connections.map((item) => item.channel)).toEqual(["messenger", "instagram"]);
    expect(JSON.stringify(result)).not.toContain("EAAPage");

    // Several Pages shared: the choice comes back, nothing stored.
    graph.pages.push({
      id: "300000000000002",
      name: "Cool Air North",
      access_token: "EAAPage-north",
      tasks: ["MESSAGING"],
    });
    const choice = await asAdmin(post(body));
    expect(await choice.json()).toMatchObject({
      outcome: "choose_page",
      pages: [{ pageId: "300000000000001" }, { pageId: "300000000000002" }],
    });
    const chosen = await asAdmin(
      post({ ...body, pageId: "300000000000002", channels: ["messenger"] }),
    );
    expect(await chosen.json()).toMatchObject({
      outcome: "connected",
      connections: [{ channel: "messenger", pageId: "300000000000002" }],
    });

    // Another business of the agency may not take a connected Page.
    const [sibling] = await t.admin
      .insert(businesses)
      .values({
        agencyId,
        segmentId: segment!.id,
        name: "Cool Air 2",
        slug: "cool-air-2",
        status: "active",
      })
      .returning({ id: businesses.id });
    const taken = await asAdmin(
      post({ businessId: sibling!.id, code: "c", pageId: "300000000000001" }),
    );
    expect(taken.status).toBe(409);
    // Staff of this agency cannot act on another agency's business.
    expect((await asAdmin(post({ ...body, businessId: tenant.businessId }))).status).toBe(403);

    expect((await handler(access("client_owner"))(post(body))).status).toBe(403);
    expect((await handler(async () => null)(post(body))).status).toBe(401);
    expect((await asAdmin(post(body, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await asAdmin(post(body, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await asAdmin(post(body, { "content-type": "text/plain" }))).status).toBe(415);
    expect((await asAdmin(post({ ...body, pageId: "../1" }))).status).toBe(400);
    expect((await asAdmin(post({ ...body, businessId: randomUUID() }))).status).toBe(404);
    graph.failNext(/oauth\/access_token/, { code: 100 });
    expect((await asAdmin(post(body))).status).toBe(502);

    const unconfigured = createFacebookLoginHandler({
      getAccess: async () => null,
      getMetaPages: () => null,
      directory: t.db.directory,
    });
    expect((await unconfigured(post(body))).status).toBe(503);
  });
});
