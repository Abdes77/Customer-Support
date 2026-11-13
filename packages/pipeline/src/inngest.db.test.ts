import { InngestTestEngine } from "@inngest/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createInngestClient, toInngestFunctions } from "@repo/jobs";

import { createHarness, type Harness, message } from "./testing/harness";

/*
 * The pipeline's functions executed by Inngest's own execution engine (through
 * @inngest/test), not by the local runner: the same definitions that /api/inngest serves.
 * Sleeps are mocked (the test engine does not wait); everything else runs for real against
 * PostgreSQL. The live check against the Inngest dev server is in docs/HUMAN_TODO.md.
 */

let h: Harness;

beforeAll(async () => {
  h = await createHarness({ runJobs: false });
});

afterAll(async () => {
  await h?.dispose();
});

describe("pipeline functions on Inngest", () => {
  it("serves reply, requested turns, send and sweeper with their debounce, concurrency and retries", () => {
    const functions = toInngestFunctions(createInngestClient({ isDev: true }), h.pipeline.jobs());
    const options = functions.map(
      (fn) => (fn as unknown as { opts: Record<string, unknown> }).opts,
    );
    expect(options.map((opts) => opts["id"])).toEqual([
      "pipeline-reply",
      "pipeline-requested-turn",
      "pipeline-send",
      "pipeline-sweeper",
      // C17: deleting data past its retention, once a day.
      "retention-purge",
    ]);
    expect(options[0]).toMatchObject({
      triggers: [{ event: "message.received" }],
      debounce: { key: "event.data.conversationId", period: "2s", timeout: "1m" },
      concurrency: [{ key: "event.data.conversationId", limit: 1 }],
    });
    expect(options[1]).toMatchObject({
      triggers: [{ event: "conversation.turn_requested" }],
      concurrency: [{ key: "event.data.conversationId", limit: 1 }],
    });
    expect(options[2]).toMatchObject({
      triggers: [{ event: "message.send_requested" }],
      concurrency: [{ key: "event.data.conversationId", limit: 1 }],
    });
    expect(options[3]).toMatchObject({ triggers: [{ cron: "* * * * *" }] });
    expect(options[4]).toMatchObject({ triggers: [{ cron: "17 8 * * *" }] });
  });

  it("round-trips a test-channel message: webhook, reply function, send function", async () => {
    const tenant = await h.newTenant();
    const response = await h.deliver(tenant, [message("Through Inngest, please")]);
    expect(response.status).toBe(200);
    const received = h.events.named("message.received").at(-1)!;

    const [reply, , send] = toInngestFunctions(
      createInngestClient({ isDev: true }),
      h.pipeline.jobs(),
    );
    const replyRun = await new InngestTestEngine({ function: reply as never }).execute({
      events: [{ name: received.name, id: received.id, data: received.data }],
      steps: [{ id: "reply-wait", handler: () => null }],
    });
    expect(replyRun.error).toBeUndefined();
    expect(replyRun.result).toMatchObject({ outcome: "replied" });

    const requested = h.events.named("message.send_requested").at(-1)!;
    const sendRun = await new InngestTestEngine({ function: send as never }).execute({
      events: [{ name: requested.name, id: requested.id, data: requested.data }],
    });
    expect(sendRun.error).toBeUndefined();
    expect(sendRun.result).toEqual({ outcome: "sent" });

    const [conversation] = await h.conversationsOf(tenant);
    expect(h.transport.textsFor(conversation!.id)).toEqual(["You said: Through Inngest, please"]);
    const rows = await h.messagesOf(tenant);
    expect(rows.map((row) => [row.direction, row.status])).toEqual([
      ["inbound", "received"],
      ["outbound", "sent"],
    ]);
  });
});
