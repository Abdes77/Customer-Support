import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PROMPT_VERSION } from "@repo/ai";
import { type MemoryTestTransport, signTestWebhook } from "@repo/channel-test";
import { ensureTestConnection } from "@repo/channel-test/server";
import { createLogger } from "@repo/core";
import { type DeploymentInfo, loadEnv } from "@repo/core/env";
import { businesses, conversationTurns, eq, messages, segments } from "@repo/db";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import { createLocalJobRunner, jobsModeFromEnv, type LocalJobRunner } from "@repo/jobs";
import { applySettingChanges } from "@repo/settings/server";

import { buildServerPipeline, inngestFunctions, type ServerPipeline } from "./index";
import { createWebhookHandler } from "./webhook-route";

const local: DeploymentInfo = { environment: "local", commitSha: null, region: null };
const hosted: DeploymentInfo = { environment: "production", commitSha: "abc", region: "iad1" };
const SECRET = "web-test-channel-secret-0123456789abcdef";
const quiet = createLogger({ level: "error", sink: () => {} });

let t: TestDatabase;
let runner: LocalJobRunner;
let server: ServerPipeline;
let accountId: string;
let businessId: string;

beforeAll(async () => {
  t = await createTestDatabase();
  runner = createLocalJobRunner({ logger: quiet, debouncePeriodMs: 100, retryDelayMs: () => 10 });
  server = buildServerPipeline({
    db: t.db,
    env: loadEnv({}),
    deployment: local,
    logger: quiet,
    runner,
    testChannelSecret: SECRET,
  });
  const { id: agencyId } = await t.db.platform.createAgency({ name: "Agency", slug: "agency" });
  const [segment] = await t.admin
    .insert(segments)
    .values({ agencyId, slug: "hvac", name: "HVAC" })
    .returning({ id: segments.id });
  const [business] = await t.admin
    .insert(businesses)
    .values({
      agencyId,
      segmentId: segment!.id,
      name: "Evergreen",
      slug: "evergreen",
      status: "active",
    })
    .returning({ id: businesses.id });
  businessId = business!.id;
  const connection = await t.db.forBusiness(business!.id).run((ctx) => ensureTestConnection(ctx));
  accountId = connection.accountId;
  await t.db.forBusiness(business!.id).run((ctx) =>
    applySettingChanges(ctx, {
      target: { scope: "business", agencyId, businessId: business!.id },
      changes: [{ key: "conversation.reply_wait_seconds.widget", value: 0 }],
      actor: { type: "system", label: "web tests" },
    }),
  );
});

afterAll(async () => {
  runner?.stop();
  await runner?.idle();
  await t?.dispose();
});

function signedRequest(body: unknown, secret = SECRET): Request {
  const raw = JSON.stringify(body);
  return new Request("http://localhost:3000/api/webhooks/test", {
    method: "POST",
    headers: signTestWebhook(secret, raw),
    body: raw,
  });
}

const params = (channel: string) => ({ params: Promise.resolve({ channel }) });

describe("POST /api/webhooks/[channel]", () => {
  it("round-trips a test-channel conversation through the webhook, the jobs and the engine", async () => {
    const handle = createWebhookHandler(() => server.pipeline);
    const response = await handle(
      signedRequest({
        accountId,
        events: [
          {
            type: "message",
            id: "web-msg-1",
            from: { id: "visitor-web" },
            text: "Is my furnace safe to run?",
            sentAt: new Date().toISOString(),
          },
        ],
      }),
      params("test"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, stored: 1, emitted: 1 });
    await runner.idle();

    const rows = await t.admin
      .select()
      .from(messages)
      .where(eq(messages.businessId, businessId as never))
      .orderBy(messages.sequence);
    // Without ANTHROPIC_API_KEY on a developer machine the offline stand-in writes the reply,
    // through the real engine: prompt, tools, output guard.
    expect(server.modelMode).toBe("offline");
    expect(rows.map((row) => [row.direction, row.author, row.status])).toEqual([
      ["inbound", "customer", "received"],
      ["outbound", "bot", "sent"],
    ]);
    expect(rows[1]?.text).toBe(
      "I'm Alex, the virtual assistant for Evergreen. Thanks for reaching out to Evergreen! What's the ZIP code of the property? How soon are you hoping to have this done?",
    );
    const transport = server.testChannel!.adapter.transport as MemoryTestTransport;
    expect(transport.textsFor(rows[0]!.conversationId)).toEqual([rows[1]?.text]);
    const turns = await t.admin
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.conversationId, rows[0]!.conversationId));
    expect(turns.map((turn) => [turn.status, turn.promptVersion])).toEqual([
      ["replied", PROMPT_VERSION],
    ]);
    // What the customer said was saved to the lead by lead scoring (C5).
    expect(
      (turns[0]?.actions as { action: { type: string }; outcome: { status: string } }[]).map(
        (entry) => [entry.action.type, entry.outcome.status],
      ),
    ).toEqual([["update_lead_fields", "applied"]]);
  });

  it("refuses a bad signature with 401 and an unknown channel with 404", async () => {
    const handle = createWebhookHandler(() => server.pipeline);
    const body = {
      accountId,
      events: [{ type: "revoked", reason: "x", occurredAt: new Date().toISOString() }],
    };
    expect((await handle(signedRequest(body, "w".repeat(40)), params("test"))).status).toBe(401);
    expect((await handle(signedRequest(body), params("carrier-pigeon"))).status).toBe(404);
    const oversized = new Request("http://localhost:3000/api/webhooks/test", {
      method: "POST",
      headers: { "content-length": String(5 * 1024 * 1024) },
      body: "{}",
    });
    expect((await handle(oversized, params("test"))).status).toBe(413);
  });

  it("answers 503 when the pipeline cannot be built", async () => {
    const handle = createWebhookHandler(() => {
      throw new Error("DATABASE_URL missing");
    });
    expect((await handle(signedRequest({}), params("test"))).status).toBe(503);
  });
});

describe("composition", () => {
  it("chooses the job runner from the environment", () => {
    expect(jobsModeFromEnv(loadEnv({}), local)).toBe("local");
    expect(jobsModeFromEnv(loadEnv({ INNGEST_DEV: "1" }), local)).toBe("inngest");
    expect(jobsModeFromEnv(loadEnv({ INNGEST_EVENT_KEY: "key" }), hosted)).toBe("inngest");
    expect(jobsModeFromEnv(loadEnv({}), hosted)).toBe("unconfigured");
    // Dev mode skips Inngest's request signatures: never on a hosted deployment.
    expect(jobsModeFromEnv(loadEnv({ INNGEST_DEV: "1" }), hosted)).toBe("unconfigured");
  });

  it("never runs the Inngest client in dev mode on a hosted deployment", () => {
    const hostedInngest = buildServerPipeline({
      db: t.db,
      env: loadEnv({ INNGEST_DEV: "1", INNGEST_EVENT_KEY: "key" }),
      deployment: hosted,
      logger: quiet,
    });
    expect(hostedInngest.inngest?.mode).toBe("cloud");
    const localInngest = buildServerPipeline({
      db: t.db,
      env: loadEnv({ INNGEST_DEV: "1" }),
      deployment: local,
      logger: quiet,
    });
    expect(localInngest.inngest?.mode).toBe("dev");
  });

  it("has no test channel on a hosted deployment without its secret, and refuses to emit without Inngest", async () => {
    const bare = buildServerPipeline({
      db: t.db,
      env: loadEnv({}),
      deployment: hosted,
      logger: quiet,
    });
    expect(bare.mode).toBe("unconfigured");
    // No key on a hosted deployment: never the offline stand-in.
    expect(bare.modelMode).toBe("unconfigured");
    expect(bare.testChannel).toBeNull();
    expect(bare.inngest).toBeNull();
    expect(bare.runner).toBeNull();
    await expect(bare.pipeline.context.events.send([])).rejects.toThrow(
      "Background jobs are not configured",
    );
  });

  it("serves the pipeline's functions on Inngest when it is configured", () => {
    const withInngest = buildServerPipeline({
      db: t.db,
      env: loadEnv({ INNGEST_DEV: "1", TEST_CHANNEL_SECRET: SECRET }),
      deployment: local,
      logger: quiet,
    });
    expect(withInngest.mode).toBe("inngest");
    expect(withInngest.inngest).not.toBeNull();
    expect(withInngest.jobs.map((job) => job.id)).toEqual([
      "pipeline-reply",
      "pipeline-send",
      "pipeline-sweeper",
      // C6: playbook generation and the website crawl.
      "knowledge-playbook-generate",
      "knowledge-import",
      // C5: lead events a failed turn left behind.
      "leads-outbox",
    ]);
    // Every definition converts to an Inngest function that /api/inngest can serve.
    expect(inngestFunctions(withInngest)).toHaveLength(withInngest.jobs.length);
  });
});
