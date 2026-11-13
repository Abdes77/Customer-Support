import { afterEach, describe, expect, it } from "vitest";

import type { MessageId } from "@repo/core";
import { asc, eq, messages } from "@repo/db";

import { createHarness, type Harness, message, reply } from "./testing/harness";
import { traceMessage } from "./trace";

let h: Harness;

afterEach(async () => {
  await h.dispose();
});

describe("traceMessage (C17)", () => {
  it("links each customer message to its turn, model calls, actions and sent replies", async () => {
    h = await createHarness();
    h.engine.respond = async (input, ports) => {
      await ports.modelCalls.record({
        trace: input.trace,
        purpose: "reply",
        model: "claude-fable-5-2",
        effort: "medium",
        promptVersion: "test",
        startedAt: new Date(0).toISOString(),
        latencyMs: 120,
        stopReason: "end_turn",
        usage: {
          inputTokens: 900,
          outputTokens: 80,
          cacheReadInputTokens: 700,
          cacheCreationInputTokens: 0,
        },
        requestId: "req_1",
        request: { secret: "never in a trace" },
        response: null,
        error: null,
      });
      return reply("Thanks, what kind of roof is it?", {
        actions: [
          {
            toolCallId: "call-1",
            action: { type: "request_photo", reason: "see the damage" } as never,
            outcome: { status: "applied", message: null, data: null },
          },
        ],
      });
    };
    const tenant = await h.newTenant({ "conversation.reply_wait_seconds.widget": 1 });
    // Two quick messages: one turn answers both.
    await h.deliver(tenant, [message("Hi, my roof leaks"), message("It's an old house")]);
    await h.idle();

    const inbound = await h.t.admin
      .select({ id: messages.id, traceId: messages.traceId })
      .from(messages)
      .where(eq(messages.businessId, tenant.tenant.businessId))
      .orderBy(asc(messages.sequence));
    const [first, second] = inbound.filter((_, index) => index < 2);
    const traces = await h.t.db
      .forBusiness(tenant.tenant.businessId)
      .run(async (ctx) => [
        await traceMessage(ctx, first!.id),
        await traceMessage(ctx, second!.id),
      ]);
    for (const trace of traces) {
      expect(trace).not.toBeNull();
      expect(trace!.turns).toHaveLength(1);
      const [turn] = trace!.turns;
      expect(turn).toMatchObject({ status: "replied", trigger: "inbound_message" });
      expect(turn!.actions).toEqual([{ type: "request_photo", status: "applied" }]);
      expect(turn!.modelCalls).toEqual([
        expect.objectContaining({ purpose: "reply", inputTokens: 900, cacheReadInputTokens: 700 }),
      ]);
      expect(turn!.replies).toHaveLength(1);
      expect(turn!.replies[0]).toMatchObject({ status: "sent" });
      expect(turn!.replies[0]!.parts).toHaveLength(1);
    }
    // Both messages lead to the same turn, under the trace of the burst's last message.
    expect(traces[0]!.turns[0]!.id).toBe(traces[1]!.turns[0]!.id);
    expect(traces[0]!.turns[0]!.traceId).toBe(second!.traceId);
    // The reply carries the turn's trace too, and nothing in a trace holds text.
    const [sent] = await h.t.admin
      .select({ traceId: messages.traceId })
      .from(messages)
      .where(eq(messages.id, traces[0]!.turns[0]!.replies[0]!.id as MessageId));
    expect(sent!.traceId).toBe(second!.traceId);
    const json = JSON.stringify(traces);
    expect(json).not.toContain("roof leaks");
    expect(json).not.toContain("what kind of roof");
    expect(json).not.toContain("never in a trace");
  });

  it("answers null for an unknown or outbound message", async () => {
    h = await createHarness();
    const tenant = await h.newTenant();
    const result = await h.t.db
      .forBusiness(tenant.tenant.businessId)
      .run((ctx) => traceMessage(ctx, "00000000-0000-4000-8000-000000000000" as MessageId));
    expect(result).toBeNull();
  });
});
