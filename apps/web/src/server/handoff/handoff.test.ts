import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signTestWebhook } from "@repo/channel-test";
import { ensureTestConnection } from "@repo/channel-test/server";
import { type AgencyId, type BusinessId, createLogger, type TraceId } from "@repo/core";
import { type DeploymentInfo, loadEnv } from "@repo/core/env";
import { alerts, businesses, conversations, eq, escalations, messages, segments } from "@repo/db";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import { runChainStep, startEscalation } from "@repo/handoff";
import { createRecordingTransports, twilioSignature } from "@repo/handoff/testing";
import { createLocalJobRunner, type LocalJobRunner } from "@repo/jobs";
import { applySettingChanges, loadSettings } from "@repo/settings/server";

import { createWebhookHandler } from "@/server/pipeline/webhook-route";
import { buildServerPipeline, type ServerPipeline } from "@/server/pipeline";

import { createAckRouteHandlers, createTwilioRouteHandler } from "./routes";

/*
 * Handoff through the app (C13), without Twilio, SMTP or WhatsApp: recording transports sit
 * behind the server pipeline's `alertTransports`. A customer's emergency goes from the
 * webhook through the reply turn (the offline model escalates it), the chain's jobs and the
 * alerts; the acknowledgement page and Twilio's callbacks are the real routes. The runner's
 * clock runs ahead, so the chain's waits pass at once. The live checks are in HUMAN_TODO 33.
 */

const local: DeploymentInfo = { environment: "local", commitSha: null, region: null };
const quiet = createLogger({ level: "error", sink: () => {} });
const APP_URL = "https://app.example.com";
const SECRET = "web-test-channel-secret-0123456789abcdef";
const TWILIO_TOKEN = "twilio-auth-token-for-tests";
const TRACE = "0e000000-0000-4000-8000-0000000000f1" as TraceId;

let t: TestDatabase;
let runner: LocalJobRunner;
let server: ServerPipeline;
let tenant: { agencyId: AgencyId; businessId: BusinessId };
let accountId: string;
const transports = createRecordingTransports();

beforeAll(async () => {
  t = await createTestDatabase();
  // Waits until a time pass at once: the runner's clock is a day ahead.
  runner = createLocalJobRunner({
    logger: quiet,
    debouncePeriodMs: 50,
    retryDelayMs: () => 10,
    now: () => new Date(Date.now() + 86_400_000),
  });
  server = buildServerPipeline({
    db: t.db,
    env: loadEnv({
      APP_URL,
      TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
      TWILIO_AUTH_TOKEN: TWILIO_TOKEN,
      TWILIO_FROM_NUMBER: "+15125550000",
    }),
    deployment: local,
    logger: quiet,
    runner,
    testChannelSecret: SECRET,
    alertTransports: transports,
  });
  const { id: agencyId } = await t.db.platform.createAgency({ name: "Agency", slug: "agency" });
  const [segment] = await t.admin
    .insert(segments)
    .values({ agencyId, slug: "plumbing", name: "Plumbing" })
    .returning({ id: segments.id });
  const [business] = await t.admin
    .insert(businesses)
    .values({
      agencyId,
      segmentId: segment!.id,
      name: "Lone Star Plumbing",
      slug: "lone-star",
      status: "active",
      timezone: "America/Chicago",
    })
    .returning({ id: businesses.id });
  tenant = { agencyId, businessId: business!.id };
  const connection = await t.db.forBusiness(business!.id).run((ctx) => ensureTestConnection(ctx));
  accountId = connection.accountId;
  await t.db.forBusiness(business!.id).run((ctx) =>
    applySettingChanges(ctx, {
      target: { scope: "business", ...tenant },
      changes: [
        { key: "conversation.reply_wait_seconds.widget", value: 0 },
        { key: "emergency.rounds", value: 1 },
        {
          key: "emergency.escalation_chain",
          value: [{ name: "Ann", phone: "+15125550101", email: "", alert_by: ["sms"] }],
        },
        {
          key: "alerts.recipients",
          value: [
            {
              name: "Owner",
              email: "owner@lonestar.example",
              phone: "",
              channels: ["email"],
              events: [],
              active: true,
            },
          ],
        },
      ],
      actor: { type: "system", label: "web tests" },
    }),
  );
});

afterAll(async () => {
  runner?.stop();
  await runner?.idle();
  await t?.dispose();
});

describe("wiring", () => {
  it("registers the handoff jobs and the three action handlers", () => {
    expect(server.jobs.map((job) => job.id)).toEqual(
      expect.arrayContaining([
        "pipeline-requested-turn",
        "handoff-emergency-chain",
        "handoff-follow-up",
        "handoff-takeover-release",
        "handoff-sweep",
      ]),
    );
    expect(server.pipeline.context.actions.types()).toEqual(
      expect.arrayContaining(["escalate_emergency", "handoff_to_human", "schedule_follow_up"]),
    );
  });
});

describe("an emergency through the app", () => {
  it("puts safety first, alerts the chain and the recipients, calls, and ends the chain unanswered", async () => {
    const handle = createWebhookHandler(() => server.pipeline);
    const raw = JSON.stringify({
      accountId,
      events: [
        {
          type: "message",
          id: "gas-1",
          from: { id: "visitor-gas", name: "Pat" },
          text: "I smell gas in the kitchen",
          sentAt: new Date().toISOString(),
        },
      ],
    });
    const response = await handle(
      new Request(`${APP_URL}/api/webhooks/test`, {
        method: "POST",
        headers: signTestWebhook(SECRET, raw),
        body: raw,
      }),
      { params: Promise.resolve({ channel: "test" }) },
    );
    expect(response.status).toBe(200);
    await runner.idle();

    const [reply] = await t.admin.select().from(messages).where(eq(messages.direction, "outbound"));
    expect(reply?.text?.startsWith("Leave the building right now")).toBe(true);
    const [escalation] = await t.admin
      .select()
      .from(escalations)
      .where(eq(escalations.businessId, tenant.businessId));
    expect(escalation).toMatchObject({ emergencyClass: "gas_leak", status: "exhausted" });
    expect(transports.sent.map((send) => `${send.channel}:${send.to}`)).toEqual(
      expect.arrayContaining([
        "sms:+15125550101",
        "voice:+15125550101",
        "email:owner@lonestar.example",
      ]),
    );
    const sms = transports.sent.find((send) => send.channel === "sms")!.text;
    expect(sms).toContain("EMERGENCY for Lone Star Plumbing: Gas smell or gas leak.");
    expect(sms).toContain(`${APP_URL}/inbox/`);
  });
});

describe("acknowledgement page and Twilio's callbacks", () => {
  async function newEscalation(): Promise<string> {
    const [conversation] = await t.admin
      .select()
      .from(conversations)
      .where(eq(conversations.businessId, tenant.businessId));
    const started = await t.db
      .forBusiness(tenant.businessId, { agencyId: tenant.agencyId })
      .run(async (ctx) =>
        startEscalation(ctx, {
          conversationId: conversation!.id,
          emergencyClass: "flooding",
          summary: null,
          traceId: TRACE,
          values: (await loadSettings(ctx, tenant)).values,
          now: new Date(),
        }),
      );
    await runChainStep(server.handoff.deps, tenant, started!.escalationId, 0);
    return started!.escalationId;
  }

  const routes = () => ({
    twilio: () => server.handoff.twilio,
    handoff: () => server.handoff.deps,
    appUrl: APP_URL,
    logger: quiet,
  });

  it("shows the page without acknowledging, acknowledges on the button, and refuses a forged link", async () => {
    const escalationId = await newEscalation();
    const link = /open (\S+)$/.exec(transports.sent.at(-1)!.text)![1]!;
    expect(link.startsWith(`${APP_URL}/api/handoff/ack/`)).toBe(true);
    const token = link.split("/").at(-1)!;
    const ack = createAckRouteHandlers(routes());

    const page = await ack.get(token);
    expect(page.status).toBe(200);
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await page.text();
    expect(html).toContain("Burst pipe or flooding");
    expect(html).toContain('<form method="post">');
    expect(html).not.toContain("Pat");
    const [still] = await t.admin
      .select()
      .from(escalations)
      .where(eq(escalations.id, escalationId));
    expect(still?.status).toBe("active");

    expect((await ack.post(`${token.slice(0, -3)}xyz`)).status).toBe(404);
    const done = await ack.post(token);
    expect(await done.text()).toContain("Thank you, Ann");
    expect(await (await ack.post(token)).text()).toContain("Already acknowledged by Ann");
    const [after] = await t.admin
      .select()
      .from(escalations)
      .where(eq(escalations.id, escalationId));
    expect(after).toMatchObject({ status: "acknowledged", acknowledgedVia: "link" });
  });

  it("checks Twilio's signature against the public URL and records delivery", async () => {
    await newEscalation();
    const [row] = await t.admin
      .select()
      .from(alerts)
      .where(eq(alerts.kind, "emergency"))
      .orderBy(alerts.createdAt);
    const handler = createTwilioRouteHandler(routes());
    const path = `/api/handoff/twilio/status?alert=${row!.id}`;
    const params = { MessageSid: "SM1", MessageStatus: "delivered" };
    const form = (signature: string) =>
      new Request(`http://internal.vercel.app${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": signature,
        },
        body: new URLSearchParams(params).toString(),
      });
    expect((await handler(form("forged"), "status")).status).toBe(403);
    const ok = await handler(
      form(twilioSignature(TWILIO_TOKEN, `${APP_URL}${path}`, params)),
      "status",
    );
    expect(ok.status).toBe(204);
    const [updated] = await t.admin.select().from(alerts).where(eq(alerts.id, row!.id));
    expect(updated?.status).toBe("delivered");
    expect((await handler(form("x"), "other")).status).toBe(404);
  });
});
