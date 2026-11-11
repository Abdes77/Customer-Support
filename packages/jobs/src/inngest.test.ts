import { InngestTestEngine } from "@inngest/test";
import { NonRetriableError, RetryAfterError } from "inngest";
import { describe, expect, it } from "vitest";

import { ExternalServiceError, ValidationError } from "@repo/core";

import { defineCronJob, defineEventJob } from "./definition";
import { jobEvent } from "./events";
import {
  createInngestClient,
  createInngestEventSender,
  INNGEST_APP_ID,
  toInngestError,
  toInngestFunctions,
} from "./inngest";
import { sampleReceivedEvent } from "./test-events";

const client = createInngestClient({ isDev: true });

interface FunctionWithOptions {
  id(prefix?: string): string;
  opts: Record<string, unknown>;
}

describe("toInngestFunctions", () => {
  it("carries id, triggers, debounce, concurrency and retries over", () => {
    const [eventFn, cronFn] = toInngestFunctions(client, [
      defineEventJob({
        id: "test-reply",
        name: "Reply",
        retries: 4,
        trigger: { event: "message.received" },
        debounce: { key: "event.data.conversationId", period: "2s", timeout: "1m" },
        concurrency: { key: "event.data.conversationId", limit: 1 },
        handler: async () => null,
        onFailure: async () => {},
      }),
      defineCronJob({
        id: "test-sweeper",
        name: "Sweeper",
        retries: 1,
        trigger: { cron: "* * * * *" },
        handler: async () => null,
      }),
    ]) as unknown as FunctionWithOptions[];

    expect(eventFn?.id(INNGEST_APP_ID)).toBe(`${INNGEST_APP_ID}-test-reply`);
    expect(eventFn?.opts).toMatchObject({
      id: "test-reply",
      retries: 4,
      triggers: [{ event: "message.received" }],
      debounce: { key: "event.data.conversationId", period: "2s", timeout: "1m" },
      concurrency: [{ key: "event.data.conversationId", limit: 1 }],
    });
    expect(typeof eventFn?.opts["onFailure"]).toBe("function");
    expect(cronFn?.opts).toMatchObject({ triggers: [{ cron: "* * * * *" }], retries: 1 });
  });

  it("executes the handler through Inngest's step machinery", async () => {
    const event = sampleReceivedEvent();
    const [fn] = toInngestFunctions(client, [
      defineEventJob({
        id: "test-steps",
        name: "Steps",
        retries: 0,
        trigger: { event: "message.received" },
        handler: async ({ event: received, step }) => {
          const first = await step.run("first", async () => ({ id: received.data.messageId }));
          await step.sleep("pause", 10_000);
          const second = await step.run("second", async () => `${first.id}!`);
          return { second, eventId: received.id };
        },
      }),
    ]);
    const t = new InngestTestEngine({ function: fn as never });
    const { result } = await t.execute({
      events: [{ name: event.name, id: event.id, data: event.data }],
      steps: [{ id: "pause", handler: () => null }],
    });
    expect(result).toEqual({ second: `${event.data.messageId}!`, eventId: event.id });
  });

  it("fails a run whose payload does not match the catalogue", async () => {
    const event = sampleReceivedEvent();
    const [fn] = toInngestFunctions(client, [
      defineEventJob({
        id: "test-invalid",
        name: "Invalid",
        retries: 0,
        trigger: { event: "message.received" },
        handler: async () => "ran",
      }),
    ]);
    const t = new InngestTestEngine({ function: fn as never });
    const { error } = await t.execute({
      events: [{ name: event.name, data: { ...event.data, conversationId: "nope" } }],
    });
    expect(String((error as Error | undefined)?.message)).toContain("Invalid payload");
  });
});

describe("toInngestError", () => {
  it("maps permanent errors, retry-after and everything else", () => {
    expect(toInngestError(new ValidationError("bad"))).toBeInstanceOf(NonRetriableError);
    const limited = toInngestError(
      new ExternalServiceError("slow down", {
        provider: "meta",
        status: 429,
        retryAfterSeconds: 30,
      }),
    );
    expect(limited).toBeInstanceOf(RetryAfterError);
    expect((limited as RetryAfterError).retryAfter).toBe("30");
    const plain = new Error("boom");
    expect(toInngestError(plain)).toBe(plain);
  });
});

describe("createInngestEventSender", () => {
  it("sends events with their ids and wraps failures", async () => {
    const requests: { url: string; body: unknown }[] = [];
    let fail = false;
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (fail) return new Response("nope", { status: 500 });
      requests.push({
        url: input instanceof Request ? input.url : input.toString(),
        body: JSON.parse(init?.body as string),
      });
      return new Response(JSON.stringify({ ids: ["x"], status: 200 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const sender = createInngestEventSender(
      createInngestClient({
        isDev: true,
        baseUrl: "http://127.0.0.1:9",
        eventKey: "test",
        fetch: fakeFetch,
      }),
    );
    const event = sampleReceivedEvent();
    await sender.send([event]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toEqual([
      expect.objectContaining({ name: "message.received", id: event.id, data: event.data }),
    ]);

    fail = true;
    await expect(sender.send([event])).rejects.toMatchObject({
      provider: "inngest",
      retryable: true,
    });
  });
});

describe("jobEvent", () => {
  it("refuses a payload that does not match the catalogue", () => {
    expect(() => jobEvent("message.send_requested", "id-1", { messageId: "x" } as never)).toThrow(
      "Invalid payload",
    );
  });
});
