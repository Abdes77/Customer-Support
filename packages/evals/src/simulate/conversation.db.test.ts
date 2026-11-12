import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { scriptedRefusal, scriptedResponse, text, toolUse } from "@repo/ai/testing";
import { ConfigError, createLogger, ExternalServiceError } from "@repo/core";

import { EvalAbortError } from "../run/retry";
import { createEvalSandbox, type EvalSandbox } from "../sandbox/sandbox";
import { afterTools, replyHintsOf, scriptedCustomer, switchableModel } from "../testing/models";
import { scenarioWith } from "../testing/transcripts";
import { runConversation } from "./conversation";
import { botEntries, customerEntries } from "./transcript";

/**
 * The conversation loop against the real engine and the production composition in the
 * sandbox. The model's answers are written by hand; everything around them is the product.
 */

const logger = createLogger({ level: "error", sink: () => undefined });
const model = switchableModel();
let sandbox: EvalSandbox;

beforeAll(async () => {
  sandbox = await createEvalSandbox({ model, logger });
});
afterAll(async () => {
  await sandbox.dispose();
});

const fields = (...pairs: [string, string | number | boolean][]) =>
  toolUse("update_lead_fields", {
    fields: pairs.map(([key, value]) => ({ key, value, confidence: 1, evidence: null })),
  });

const systemText = (request: { system: readonly { text: string }[] }) =>
  request.system.map((block) => block.text).join("\n");

describe("a conversation against the production composition", () => {
  it("plays turn after turn with the business's real facts, playbook and routing rules", async () => {
    const scenario = scenarioWith({ persona: "ready_to_book", suite: "roofing" });
    model.use((request) => {
      const hints = replyHintsOf(request);
      if (afterTools(request)) {
        return scriptedResponse([
          text(
            hints.firstReply
              ? "I'm Alex, the virtual assistant for Ridgeline Roofing. Sorry about that stain. What's the ZIP code, and how soon do you need someone?"
              : "Thanks Dana. Someone from Ridgeline Roofing will reach out within one business day.",
          ),
        ]);
      }
      if (hints.firstReply) {
        return scriptedResponse([
          fields(["service_type", "roof leak repair"], ["job_scope", "stain by the chimney"]),
        ]);
      }
      if (hints.customerText.includes("80226")) {
        return scriptedResponse([
          fields(
            ["service_area", "80226"],
            ["timeline", "this_week"],
            ["decision_maker", "homeowner"],
          ),
        ]);
      }
      return scriptedResponse([text("An inspection is the first step. Anything else?")]);
    });
    const customer = scriptedCustomer([
      "80226, this week, we own it",
      { messages: ["how much is an inspection?"], leave: "satisfied" },
    ]);
    const transcript = await runConversation(scenario, { sandbox, customer, logger });

    expect(transcript.ended).toBe("customer_left");
    expect(customerEntries(transcript).map((entry) => entry.source)).toEqual([
      "opening",
      "simulated",
      "simulated",
    ]);
    expect(botEntries(transcript)).toHaveLength(3);
    // The real scoring rules, in the dry run's memory: a hot lead is to be booked.
    expect(transcript.lead.routing).toMatchObject({ outcome: "book_meeting", band: "hot" });
    expect(botEntries(transcript)[1]?.routing).toBe("book_meeting");
    expect(Object.keys(transcript.lead.fields).sort()).toEqual([
      "decision_maker",
      "job_scope",
      "service_area",
      "service_type",
      "timeline",
    ]);

    // The engine was given what production would give it, from the sandbox database:
    const first = model.requests[0];
    if (first === undefined) throw new Error("no request");
    expect(systemText(first)).toContain("Ridgeline Roofing");
    // ... the business's core facts, through the production retriever,
    expect(systemText(first)).toContain("GAF Certified contractor");
    // ... the segment's stored playbook, through the production loader,
    expect(systemText(first)).toContain("shingles are in my yard");
    // ... and the profile's settings: prices are never disclosed, so no price fact is core.
    expect(systemText(first)).not.toContain("$149");
    expect(first.model).toBe("claude-fable-5-2");
    expect(first.tools?.length).toBe(10);

    // A question about price brings the pricing fact through full-text retrieval, per turn.
    const last = JSON.stringify(model.requests.at(-1)?.messages.at(-1));
    expect(last).toContain("A roof inspection costs $149");

    // The customer saw the bot's replies and nothing else.
    expect(customer.inputs).toHaveLength(2);
    expect(JSON.stringify(customer.inputs[0]?.entries)).toContain("What's the ZIP code");
    expect(transcript.engineModels).toEqual(["claude-fable-5-2"]);
    expect(transcript.promptVersion).toMatch(/^reply-v\d+\.r\d+$/);
  });

  it("goes quiet, gets a follow-up, and comes back a day later", async () => {
    const scenario = scenarioWith({ persona: "silent_returner", profile: "default" });
    const purposes: string[] = [];
    model.use((request) => {
      purposes.push(`${request.purpose}:${replyHintsOf(request).purpose}`);
      return scriptedResponse([
        text(
          replyHintsOf(request).firstReply
            ? `I'm Alex, the virtual assistant for ${scenario.business.name}. What's the ZIP code?`
            : "Got it. How soon?",
        ),
      ]);
    });
    const customer = scriptedCustomer([
      "it's in town",
      "sorry, got pulled away. this month",
      { leave: "satisfied" },
    ]);
    const transcript = await runConversation(scenario, { sandbox, customer, logger });

    expect(
      transcript.entries.map((entry) => (entry.kind === "event" ? entry.event : entry.kind)),
    ).toEqual([
      "customer",
      "bot",
      "customer",
      "bot",
      "customer_silent",
      "bot",
      "customer_returned",
      "customer",
      "bot",
    ]);
    const [, second, nudge, afterReturn] = botEntries(transcript);
    expect(nudge?.trigger).toBe("follow_up");
    // The follow-up is its own kind of turn for the engine: the follow-up model settings.
    expect(purposes[2]).toBe("follow_up:nudge");
    const hours = (later: string | undefined, earlier: string | undefined) =>
      (Date.parse(later ?? "") - Date.parse(earlier ?? "")) / 3_600_000;
    // The first follow-up is due after the channel's first delay; the customer returns 26 h after going quiet.
    const delay = scenario.settings.values[`follow_up.delays_minutes.${scenario.channel}`][0] ?? 0;
    expect(hours(nudge?.at, second?.at)).toBeCloseTo(delay / 60, 1);
    expect(hours(afterReturn?.at, second?.at)).toBeCloseTo(26, 0);
    // The simulated customer is told that a day has passed.
    expect(customer.inputs.map((input) => input.returning)).toEqual([false, true, false]);
  });

  it("stops when the bot hands the conversation to a person", async () => {
    const scenario = scenarioWith({ persona: "angry_past_job" });
    model.use((request) =>
      afterTools(request)
        ? scriptedResponse([
            text("I'm sorry about this. I'm bringing in a member of the team right now."),
          ])
        : scriptedResponse([
            toolUse("handoff_to_human", { reason: "Upset about past work", urgency: "high" }),
          ]),
    );
    const customer = scriptedCustomer(["this should never be reached"]);
    const transcript = await runConversation(scenario, { sandbox, customer, logger });
    expect(transcript.ended).toBe("handed_off");
    expect(transcript.handedOff).toBe(true);
    expect(transcript.lead.status).toBe("handed_off");
    expect(customer.inputs).toHaveLength(0);
  });

  it("keeps the bot silent after it stopped replying to a spammer, as production's guard does", async () => {
    const scenario = scenarioWith({ persona: "spam", profile: "default" });
    model.use((request) =>
      afterTools(request)
        ? scriptedResponse([text("<no_reply/>")])
        : scriptedResponse([
            toolUse("mark_not_a_fit", { category: "solicitation", reason: "SEO agency pitch" }),
            toolUse("end_conversation", { reason: "Solicitation", disposition: "stop_replying" }),
          ]),
    );
    const transcript = await runConversation(scenario, {
      sandbox,
      customer: scriptedCustomer([]),
      logger,
    });
    expect(transcript.ended).toBe("bot_stopped_replying");
    expect(customerEntries(transcript).map((entry) => entry.source)).toEqual([
      "opening",
      "scripted",
      "scripted",
    ]);
    // One engine turn; the two later lines are stored and nobody answers.
    expect(botEntries(transcript)).toHaveLength(1);
    expect(model.requests).toHaveLength(2);
    expect(
      transcript.entries.filter((entry) => entry.kind === "event").map((entry) => entry.event),
    ).toEqual(["bot_held_silent", "bot_held_silent"]);
    expect(transcript.lead.routing?.outcome).toBe("disqualify");
  });

  it("lets production's own handler refuse a photo request the settings do not allow", async () => {
    const scenario = scenarioWith({ profile: "contact_only", persona: "ready_to_book" });
    expect(scenario.settings.values["photos.request_mode"]).toBe("never");
    model.use((request) =>
      afterTools(request)
        ? scriptedResponse([text("Thanks. What's the ZIP code?")])
        : scriptedResponse([toolUse("request_photo", { subject: "the ceiling stain" })]),
    );
    const transcript = await runConversation(scenario, {
      sandbox,
      customer: scriptedCustomer([{ leave: "nothing_more" }]),
      logger,
    });
    const [request] = botEntries(transcript)[0]?.actions ?? [];
    expect(request?.outcome.status).toBe("rejected");
    expect(request?.outcome.message).toContain("does not ask customers for photos");
  });

  it("sends the customer's photo and gives the bot what it shows", async () => {
    const scenario = scenarioWith({ persona: "ready_to_book", channel: "whatsapp" });
    model.use((request) => {
      const hints = replyHintsOf(request);
      if (afterTools(request))
        return scriptedResponse([text("Thanks, that helps. What's the ZIP code?")]);
      if (hints.unanalyzedPhotos.length > 0) {
        return scriptedResponse([
          toolUse("analyze_photos", {
            attachment_ids: [...hints.unanalyzedPhotos],
            question: "What does it show?",
          }),
        ]);
      }
      return scriptedResponse([
        text(
          `I'm Alex, the virtual assistant for ${scenario.business.name}. Could you send a photo of the stain?`,
        ),
      ]);
    });
    const transcript = await runConversation(scenario, {
      sandbox,
      customer: scriptedCustomer([{ messages: ["here"], photo: true }, { leave: "satisfied" }]),
      logger,
    });
    expect(transcript.photosSent).toBe(1);
    expect(customerEntries(transcript)[1]?.messages[0]?.photo).toBe(scenario.instance.truth.photo);
    const analysis = botEntries(transcript)[1]?.actions[0];
    expect(analysis?.action.type).toBe("analyze_photos");
    expect(JSON.stringify(analysis?.outcome.data)).toContain("water stain");
  });

  it("books only from the calendar's slots where a calendar is connected", async () => {
    const scenario = scenarioWith({ profile: "booking_with_ranges", persona: "ready_to_book" });
    model.use((request) => {
      if (afterTools(request)) {
        const result = JSON.stringify(request.messages.at(-1));
        return scriptedResponse([
          text(
            result.includes("Thursday, November 5 at 9:00 AM")
              ? "How about Thursday, November 5 at 9:00 AM?"
              : "Noted.",
          ),
        ]);
      }
      return scriptedResponse([toolUse("offer_times", { preference: null, count: 2 })]);
    });
    const withCalendar = await runConversation(scenario, {
      sandbox,
      customer: scriptedCustomer([{ leave: "satisfied" }]),
      logger,
    });
    expect(botEntries(withCalendar)[0]?.actions[0]?.outcome.status).toBe("applied");
    expect(botEntries(withCalendar)[0]?.replies[0]?.text).toContain(
      "Thursday, November 5 at 9:00 AM",
    );

    const noCalendar = scenarioWith({ profile: "default", persona: "ready_to_book" });
    const without = await runConversation(noCalendar, {
      sandbox,
      customer: scriptedCustomer([{ leave: "satisfied" }]),
      logger,
    });
    expect(botEntries(without)[0]?.actions[0]?.outcome).toMatchObject({ status: "rejected" });
  });
});

describe("what is not the bot's doing", () => {
  const scenario = scenarioWith({ persona: "ready_to_book", profile: "default" });
  const noWait = { baseMs: 0, sleep: async () => undefined };

  it("retries a turn the API failed and counts the retry", async () => {
    model.use((_request, call) => {
      if (call === 1) {
        throw new ExternalServiceError("The Claude API answered 529.", {
          provider: "anthropic",
          status: 529,
        });
      }
      return scriptedResponse([
        text(`I'm Alex, the virtual assistant for ${scenario.business.name}. What's the ZIP code?`),
      ]);
    });
    const transcript = await runConversation(scenario, {
      sandbox,
      customer: scriptedCustomer([{ leave: "satisfied" }]),
      logger,
      retry: noWait,
    });
    expect(transcript.retries).toBe(1);
    expect(botEntries(transcript)).toHaveLength(1);
    // The retried turn is the same turn: one customer entry, the same clock.
    expect(customerEntries(transcript)).toHaveLength(1);
    expect(customerEntries(transcript)[0]?.at).toBe(scenario.startAt);
  });

  it("gives up after the last attempt and throws: an outage is not a score", async () => {
    model.use(() => {
      throw new ExternalServiceError("The Claude API answered 529.", {
        provider: "anthropic",
        status: 529,
      });
    });
    await expect(
      runConversation(scenario, {
        sandbox,
        customer: scriptedCustomer([]),
        logger,
        retry: { ...noWait, attempts: 2 },
      }),
    ).rejects.toThrow(ExternalServiceError);
    expect(model.requests).toHaveLength(2);
  });

  it("throws a configuration error for a refused key instead of grading a failed turn", async () => {
    model.use(() => {
      throw new ConfigError("The Claude API rejected the API key.");
    });
    await expect(
      runConversation(scenario, { sandbox, customer: scriptedCustomer([]), logger, retry: noWait }),
    ).rejects.toThrow(ConfigError);
    model.use(() => {
      throw new ExternalServiceError("The Claude API answered 400.", {
        provider: "anthropic",
        status: 400,
      });
    });
    await expect(
      runConversation(scenario, { sandbox, customer: scriptedCustomer([]), logger, retry: noWait }),
    ).rejects.toThrow(/no retry can fix/);
  });

  it("stops at the time limit", async () => {
    const controller = new AbortController();
    controller.abort();
    model.use(() => scriptedResponse([text("hi")]));
    await expect(
      runConversation(scenario, {
        sandbox,
        customer: scriptedCustomer([]),
        logger,
        signal: controller.signal,
      }),
    ).rejects.toThrow(EvalAbortError);
  });
});

describe("what is the bot's doing", () => {
  const scenario = scenarioWith({ persona: "ready_to_book", profile: "default" });

  it("ends a conversation the model declined to answer, as a graded outcome", async () => {
    model.use(() => scriptedRefusal("cyber"));
    const transcript = await runConversation(scenario, {
      sandbox,
      customer: scriptedCustomer([]),
      logger,
    });
    expect(transcript.ended).toBe("refused");
    expect(botEntries(transcript)[0]?.outcome).toBe("refused");
  });

  it("ends a conversation in which the engine could not produce a reply", async () => {
    model.use(() => scriptedResponse([text("cut o")], { stopReason: "max_tokens" }));
    const transcript = await runConversation(scenario, {
      sandbox,
      customer: scriptedCustomer([]),
      logger,
    });
    expect(transcript.ended).toBe("engine_failed");
    expect(botEntries(transcript)[0]?.diagnostics?.notes).toContain("max_tokens");
  });

  it("caps the customer turns", async () => {
    model.use(() =>
      scriptedResponse([
        text(`I'm Alex, the virtual assistant for ${scenario.business.name}. Tell me more.`),
      ]),
    );
    const transcript = await runConversation(scenario, {
      sandbox,
      customer: scriptedCustomer(["more", "and more", "and more still"]),
      logger,
      maxCustomerTurns: 2,
    });
    expect(transcript.ended).toBe("max_turns");
    expect(customerEntries(transcript)).toHaveLength(2);
  });
});

describe("invariant I8", () => {
  it("left nothing in the tables a live turn writes, after all of the above", async () => {
    const counts = await sandbox.turnRowCounts();
    expect(Object.keys(counts).length).toBeGreaterThan(10);
    expect(Object.values(counts).every((rows) => rows === 0)).toBe(true);
  });
});
