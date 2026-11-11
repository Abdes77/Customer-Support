import { describe, expect, it } from "vitest";

import { type ConversationId, ExternalServiceError, ValidationError } from "@repo/core";

import { defineCronJob, defineEventJob, type JobDefinition } from "./definition";
import { cronMatches, createLocalJobRunner } from "./local-runner";
import { sampleReceivedEvent } from "./test-events";

const conversationA = "5d7f9b1c-3e5a-4c7e-9a1b-2c4e6f8a0b04" as ConversationId;
const conversationB = "6e8a0c2d-4f6b-4d8f-8b2c-3d5f7a9b1c05" as ConversationId;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function runner(definitions: JobDefinition[], debouncePeriodMs?: number) {
  const local = createLocalJobRunner({
    retryDelayMs: () => 5,
    ...(debouncePeriodMs === undefined ? {} : { debouncePeriodMs }),
  });
  local.register(definitions);
  return local;
}

describe("local job runner", () => {
  it("runs a job once per event id", async () => {
    const seen: string[] = [];
    const local = runner([
      defineEventJob({
        id: "test-plain",
        name: "Plain",
        retries: 0,
        trigger: { event: "message.received" },
        handler: async ({ event }) => {
          seen.push(event.data.messageId);
        },
      }),
    ]);
    const event = sampleReceivedEvent();
    await local.send([event, event]);
    await local.send([event]);
    await local.idle();
    expect(seen).toEqual([event.data.messageId]);
  });

  it("debounces by key and runs with the latest event", async () => {
    const seen: string[] = [];
    const local = runner(
      [
        defineEventJob({
          id: "test-debounce",
          name: "Debounced",
          retries: 0,
          trigger: { event: "message.received" },
          debounce: { key: "event.data.conversationId", period: "1s" },
          handler: async ({ event }) => {
            seen.push(event.data.messageId);
          },
        }),
      ],
      // Far longer than the pause between the two sends, even on a loaded machine.
      1000,
    );
    const first = sampleReceivedEvent({ conversationId: conversationA });
    const second = sampleReceivedEvent({ conversationId: conversationA });
    const other = sampleReceivedEvent({ conversationId: conversationB });
    await local.send([first]);
    await sleep(10);
    await local.send([second, other]);
    await local.idle();
    expect(seen.sort()).toEqual([second.data.messageId, other.data.messageId].sort());
  });

  it("runs one job at a time per concurrency key", async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const local = runner([
      defineEventJob({
        id: "test-concurrency",
        name: "Serialised",
        retries: 0,
        trigger: { event: "message.received" },
        concurrency: { key: "event.data.conversationId", limit: 1 },
        handler: async ({ event }) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await sleep(15);
          order.push(event.data.messageId);
          active -= 1;
        },
      }),
    ]);
    const events = [1, 2, 3].map(() => sampleReceivedEvent({ conversationId: conversationA }));
    await local.send(events);
    await local.idle();
    expect(maxActive).toBe(1);
    expect(order).toEqual(events.map((event) => event.data.messageId));
  });

  it("lets another run of the same key work while a run sleeps", async () => {
    const order: string[] = [];
    const local = runner([
      defineEventJob({
        id: "test-sleep-slot",
        name: "Sleeper",
        retries: 0,
        trigger: { event: "message.received" },
        concurrency: { key: "event.data.conversationId", limit: 1 },
        handler: async ({ event, step }) => {
          if (event.data.channel === "widget") {
            await step.sleep("nap", 40);
            order.push("sleeper woke");
          } else {
            order.push("other ran");
          }
        },
      }),
    ]);
    await local.send([
      sampleReceivedEvent({ conversationId: conversationA, channel: "widget" }),
      sampleReceivedEvent({ conversationId: conversationA, channel: "test" }),
    ]);
    await local.idle();
    expect(order).toEqual(["other ran", "sleeper woke"]);
  });

  it("memoizes steps across retries and retries failed attempts", async () => {
    let sideEffects = 0;
    let attempts = 0;
    const local = runner([
      defineEventJob({
        id: "test-memo",
        name: "Memo",
        retries: 3,
        trigger: { event: "message.received" },
        handler: async ({ step }) => {
          const value = await step.run("side-effect", async () => {
            sideEffects += 1;
            return { at: new Date(0) };
          });
          // Step results go through JSON, as under Inngest.
          expect(typeof value.at).toBe("string");
          await step.run("flaky", async () => {
            attempts += 1;
            if (attempts < 3) throw new Error("temporary");
            return "ok";
          });
        },
      }),
    ]);
    await local.send([sampleReceivedEvent()]);
    await local.idle();
    expect(sideEffects).toBe(1);
    expect(attempts).toBe(3);
    expect(local.history.map((run) => [run.status, run.attempts])).toEqual([["completed", 3]]);
  });

  it("does not retry a permanent error and calls onFailure once", async () => {
    let calls = 0;
    const failures: string[] = [];
    const local = runner([
      defineEventJob({
        id: "test-permanent",
        name: "Permanent",
        retries: 5,
        trigger: { event: "message.received" },
        handler: async () => {
          calls += 1;
          throw new ValidationError("bad input");
        },
        onFailure: async ({ error, event }) => {
          failures.push(`${error.code}:${event.data.channel}`);
        },
      }),
    ]);
    await local.send([sampleReceivedEvent()]);
    await local.idle();
    expect(calls).toBe(1);
    expect(failures).toEqual(["validation_failed:test"]);
  });

  it("gives up after the retries and reports the last error", async () => {
    let calls = 0;
    const failures: string[] = [];
    const local = runner([
      defineEventJob({
        id: "test-exhausted",
        name: "Exhausted",
        retries: 2,
        trigger: { event: "message.received" },
        handler: async () => {
          calls += 1;
          throw new ExternalServiceError("vendor down", { provider: "x", status: 503 });
        },
        onFailure: async ({ error }) => {
          failures.push(error.message);
        },
      }),
    ]);
    await local.send([sampleReceivedEvent()]);
    await local.idle();
    expect(calls).toBe(3);
    expect(failures).toEqual(["vendor down"]);
  });

  it("refuses an invalid payload without running the handler or onFailure", async () => {
    let calls = 0;
    const local = runner([
      defineEventJob({
        id: "test-invalid",
        name: "Invalid",
        retries: 2,
        trigger: { event: "message.received" },
        handler: async () => {
          calls += 1;
        },
        onFailure: async () => {
          calls += 100;
        },
      }),
    ]);
    const event = sampleReceivedEvent();
    await local.send([{ ...event, data: { ...event.data, businessId: "not-a-uuid" } as never }]);
    await local.idle();
    expect(calls).toBe(0);
    expect(local.history[0]?.status).toBe("failed");
  });

  it("rejects a step id used twice in one run", async () => {
    const local = runner([
      defineEventJob({
        id: "test-duplicate-step",
        name: "Duplicate",
        retries: 0,
        trigger: { event: "message.received" },
        handler: async ({ step }) => {
          await step.run("same", async () => 1);
          await step.run("same", async () => 2);
        },
      }),
    ]);
    await local.send([sampleReceivedEvent()]);
    await local.idle();
    expect(local.history[0]?.error).toContain("Step id used twice");
  });

  it("runs cron jobs on demand", async () => {
    let runs = 0;
    const local = runner([
      defineCronJob({
        id: "test-cron",
        name: "Cron",
        retries: 0,
        trigger: { cron: "* * * * *" },
        handler: async () => {
          runs += 1;
        },
      }),
    ]);
    await local.runCron("test-cron");
    expect(runs).toBe(1);
    await expect(local.runCron("missing")).rejects.toThrow("No cron job");
  });
});

describe("cronMatches", () => {
  const at = new Date("2026-11-11T18:30:00.000Z"); // a Wednesday
  it.each([
    ["* * * * *", true],
    ["30 18 * * *", true],
    ["*/15 * * * *", true],
    ["*/7 * * * *", false],
    ["0 18 * * *", false],
    ["30 18 11 11 3", true],
    ["30 18 * * 1-5", true],
    ["30 18 * * 0,6", false],
  ])("%s → %s", (expression, expected) => {
    expect(cronMatches(expression, at)).toBe(expected);
  });

  it("refuses expressions with the wrong number of fields", () => {
    expect(() => cronMatches("* * * *", at)).toThrow("Unsupported cron");
  });
});
