import { describe, expect, it } from "vitest";

import {
  type ActionHandler,
  CHANNEL_CAPABILITIES,
  createLogger,
  type EngineTurnInput,
  type ToolExecutionContext,
  type TraceId,
} from "@repo/core";
import { settingsWith } from "@repo/settings";

import { createActionHandlerRegistry, createToolRuntime, defaultActionOutcome } from "./actions";
import { createAdapterRegistry } from "./adapters";
import { createEchoEngine } from "./echo-engine";
import { textToHtml } from "./send/prepare";
import { splitText } from "./send/split";
import { messagingWindow } from "./send/window";

const quiet = createLogger({ level: "error", sink: () => {} });

describe("splitText", () => {
  it("keeps a text that fits as one part, trimmed, and drops an empty one", () => {
    expect(splitText("  Hello there.  ", 100)).toEqual(["Hello there."]);
    expect(splitText("   ", 100)).toEqual([]);
  });

  it("prefers paragraphs, then sentences, then words, and keeps every word in order", () => {
    const text =
      "First paragraph is here.\n\nSecond paragraph has two sentences. This is the second one. " +
      "And a third sentence that is rather long and keeps going for a while.";
    for (const max of [30, 45, 60, 80, 120]) {
      const parts = splitText(text, max);
      expect(parts.every((part) => part.length <= max && part.length > 0)).toBe(true);
      expect(parts.join(" ").split(/\s+/)).toEqual(text.split(/\s+/));
    }
    expect(splitText(text, 60)[0]).toBe("First paragraph is here.");
    expect(splitText("One sentence here. Another one follows here.", 30)).toEqual([
      "One sentence here.",
      "Another one follows here.",
    ]);
  });

  it("cuts a word that is longer than the limit, and never inside an emoji", () => {
    expect(splitText("a".repeat(25), 10)).toEqual(["a".repeat(10), "a".repeat(10), "a".repeat(5)]);
    const emoji = `${"a".repeat(9)}😀b`;
    const parts = splitText(emoji, 10);
    expect(parts.join("")).toBe(emoji);
    expect(parts[0]).toBe("a".repeat(9));
  });

  it("refuses a limit below one", () => {
    expect(() => splitText("x", 0)).toThrow(RangeError);
  });
});

describe("messagingWindow", () => {
  const now = new Date("2026-11-11T18:00:00.000Z");
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

  it("is always open on channels without a window", () => {
    expect(messagingWindow(CHANNEL_CAPABILITIES.widget, null, now)).toEqual({
      open: true,
      closesAt: null,
    });
  });

  it("follows the 24-hour window, and the human-agent extension where there is one", () => {
    expect(messagingWindow(CHANNEL_CAPABILITIES.whatsapp, hoursAgo(23), now).open).toBe(true);
    expect(messagingWindow(CHANNEL_CAPABILITIES.whatsapp, hoursAgo(25), now)).toEqual({
      open: false,
      closesAt: hoursAgo(1).toISOString(),
    });
    expect(messagingWindow(CHANNEL_CAPABILITIES.whatsapp, hoursAgo(25), now, true).open).toBe(
      false,
    );
    expect(messagingWindow(CHANNEL_CAPABILITIES.messenger, hoursAgo(25), now, true).open).toBe(
      true,
    );
    expect(messagingWindow(CHANNEL_CAPABILITIES.messenger, hoursAgo(25), now, false).open).toBe(
      false,
    );
    expect(messagingWindow(CHANNEL_CAPABILITIES.instagram, hoursAgo(200), now, true).open).toBe(
      false,
    );
    expect(messagingWindow(CHANNEL_CAPABILITIES.whatsapp, null, now).open).toBe(false);
  });
});

describe("textToHtml", () => {
  it("escapes and keeps paragraphs and line breaks", () => {
    expect(textToHtml("Hi <b>you</b> & co\nline two\n\nNext")).toBe(
      "<p>Hi &lt;b&gt;you&lt;/b&gt; &amp; co<br>line two</p>\n<p>Next</p>",
    );
  });
});

describe("registries", () => {
  it("refuses a second adapter or handler for the same key", () => {
    const adapter = { channel: "test", capabilities: CHANNEL_CAPABILITIES.test } as never;
    const adapters = createAdapterRegistry([adapter]);
    expect(adapters.channels()).toEqual(["test"]);
    expect(() => adapters.register(adapter)).toThrow("already registered");
    const handler: ActionHandler<"request_photo"> = {
      type: "request_photo",
      handle: async () => ({ status: "applied", message: null, data: null }),
    };
    const actions = createActionHandlerRegistry([handler]);
    expect(() => actions.register(handler)).toThrow("already registered");
  });
});

describe("tool runtime", () => {
  const context: ToolExecutionContext = {
    trace: {
      traceId: "0b9b6d1c-2a51-4d0e-9a55-0d0f6a4f3a01" as TraceId,
      agencyId: "3f2b8c1e-7d4a-4b6f-8e21-5c9a7d1e2f02" as never,
      businessId: "9a1c3e5f-2b4d-4f6a-8c0e-1d3f5a7b9c03" as never,
      conversationId: null,
    },
    mode: "live",
    toolCallId: "toolu_1",
    now: "2026-11-11T18:00:00.000Z",
    settings: settingsWith({}),
    channel: {
      id: "test",
      capabilities: CHANNEL_CAPABILITIES.test,
      window: { open: true, closesAt: null },
    },
    business: {
      id: "9a1c3e5f-2b4d-4f6a-8c0e-1d3f5a7b9c03" as never,
      agencyId: "3f2b8c1e-7d4a-4b6f-8e21-5c9a7d1e2f02" as never,
      name: "Summit Roofing",
      segment: {
        id: "5d1c3e5f-2b4d-4f6a-8c0e-1d3f5a7b9c04" as never,
        slug: "roofing",
        name: "Roofing",
      },
      timezone: "America/Denver",
    },
  };

  it("records unhandled actions as deferred and refuses scheduling until C12", async () => {
    const tools = createToolRuntime({ registry: createActionHandlerRegistry(), logger: quiet });
    expect(
      await tools.execute({ type: "handoff_to_human", reason: "asked", urgency: "high" }, context),
    ).toMatchObject({ status: "deferred" });
    expect(
      await tools.execute({ type: "offer_times", preference: null, count: 2 }, context),
    ).toMatchObject({
      status: "rejected",
    });
    expect(defaultActionOutcome("book_meeting").status).toBe("rejected");
  });

  it("validates the model's action again and contains handler errors", async () => {
    const registry = createActionHandlerRegistry([
      {
        type: "request_photo",
        handle: async () => {
          throw new Error("boom");
        },
      },
    ]);
    const tools = createToolRuntime({ registry, logger: quiet });
    expect(
      await tools.execute({ type: "request_photo", subject: "" } as never, context),
    ).toMatchObject({
      status: "rejected",
    });
    expect(await tools.execute({ type: "launch_rockets" } as never, context)).toMatchObject({
      status: "rejected",
    });
    expect(
      await tools.execute({ type: "request_photo", subject: "the panel" }, context),
    ).toMatchObject({
      status: "failed",
    });
  });

  it("hands valid actions to their handler", async () => {
    const seen: string[] = [];
    const registry = createActionHandlerRegistry([
      {
        type: "request_photo",
        handle: async (action, ctx) => {
          seen.push(`${action.subject}:${ctx.toolCallId}`);
          return { status: "applied", message: null, data: { asked: true } };
        },
      },
    ]);
    const tools = createToolRuntime({ registry, logger: quiet });
    expect(await tools.execute({ type: "request_photo", subject: "the roof" }, context)).toEqual({
      status: "applied",
      message: null,
      data: { asked: true },
    });
    expect(seen).toEqual(["the roof:toolu_1"]);
  });
});

describe("echo engine", () => {
  const settings = settingsWith({});
  const base = {
    channel: {
      id: "test",
      capabilities: CHANNEL_CAPABILITIES.test,
      window: { open: true, closesAt: null },
    },
    settings,
    history: [],
  } as unknown as EngineTurnInput;
  const turn = (text: string | null, files = 0) => ({
    messageId: "m" as never,
    author: "customer" as const,
    sentAt: "2026-11-11T18:00:00.000Z",
    text,
    attachments: Array.from({ length: files }, (_unused, index) => ({
      id: `a${index}`,
      kind: "image" as const,
      mimeType: null,
      storage: null,
    })),
    subject: null,
  });

  it("repeats the pending messages and stays silent without any", async () => {
    const engine = createEchoEngine();
    const ports = {} as never;
    const replied = await engine.respond(
      { ...base, pending: [turn("a"), turn(null, 1), turn("b")] },
      ports,
    );
    expect(replied).toMatchObject({
      outcome: "replied",
      replies: [{ kind: "text", text: "You said: a / b\n(1 attachment received)" }],
      settingsVersion: settings.version,
    });
    expect((await engine.respond({ ...base, pending: [] }, ports)).outcome).toBe("no_reply");
    const email = await engine.respond(
      {
        ...base,
        channel: { ...base.channel, capabilities: CHANNEL_CAPABILITIES.email },
        pending: [turn("hello")],
      },
      ports,
    );
    expect(email.replies[0]).toEqual({ kind: "email", subject: null, text: "You said: hello" });
  });
});
