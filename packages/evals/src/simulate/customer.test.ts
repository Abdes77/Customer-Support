import { describe, expect, it } from "vitest";

import {
  createScriptedModelClient,
  scriptedRefusal,
  scriptedResponse,
  text,
} from "@repo/ai/testing";
import type { TraceContext } from "@repo/core";
import { createLogger } from "@repo/core";

import { botSays, customerSays, scenarioWith } from "../testing/transcripts";
import {
  createCustomerSimulator,
  customerHints,
  customerMessages,
  customerSystemPrompt,
  parseCustomerMove,
} from "./customer";
import { createStandInCustomerModel, standInMove } from "./stand-in-customer";
import type { CallSummary, TranscriptEntry } from "./transcript";

const logger = createLogger({ level: "error", sink: () => undefined });
const scenario = scenarioWith({ persona: "ready_to_book", profile: "default" });
const trace = {
  traceId: "00000000-0000-4000-8000-000000000001",
  agencyId: "00000000-0000-4000-8000-000000000002",
  businessId: "00000000-0000-4000-8000-000000000003",
  conversationId: null,
} as TraceContext;

describe("parseCustomerMove", () => {
  it("reads one message", () => {
    expect(parseCustomerMove("it's 80226")).toEqual({
      messages: ["it's 80226"],
      photo: false,
      leave: null,
    });
  });

  it("splits separate messages, attaches the photo and reads the goodbye", () => {
    expect(
      parseCustomerMove("here you go\n[photo]\n---\nthats the ceiling\n[end: satisfied]"),
    ).toEqual({
      messages: ["here you go", "thats the ceiling"],
      photo: true,
      leave: "satisfied",
    });
  });

  it("takes an end marker alone as a customer who does not answer", () => {
    expect(parseCustomerMove("[end: gave_up]")).toEqual({
      messages: [],
      photo: false,
      leave: "gave_up",
    });
    expect(parseCustomerMove("  ")).toEqual({ messages: [], photo: false, leave: "nothing_more" });
  });

  it("is forgiving about the form: quotes, an unknown reason, capitals, too many messages", () => {
    expect(parseCustomerMove('"ok thanks"\n[END: Bye For Now]')).toEqual({
      messages: ["ok thanks"],
      photo: false,
      leave: "nothing_more",
    });
    expect(parseCustomerMove("a\n---\nb\n---\nc\n---\nd").messages).toEqual(["a", "b", "c"]);
    expect(parseCustomerMove(`"I said "no" twice"`).messages).toEqual([`"I said "no" twice"`]);
  });
});

describe("the simulator's prompt", () => {
  it("gives the model the persona and the customer's own facts, and nothing about the bot's rules", () => {
    const prompt = customerSystemPrompt(scenario);
    expect(prompt).toContain(scenario.persona.brief);
    expect(prompt).toContain(scenario.instance.truth.name);
    expect(prompt).toContain(`ZIP ${scenario.instance.truth.zip}`);
    expect(prompt).toContain("Are you guys licensed and insured?");
    expect(prompt).toContain("[end: reason]");
    // The customer does not know what a good outcome is, how leads are routed or scored.
    expect(prompt).not.toContain(scenario.persona.goodOutcome);
    expect(prompt).not.toMatch(/routing|book_meeting|score|rubric|judge/i);
  });

  it("shows the conversation from the customer's side and ends on the bot's turn", () => {
    const entries: TranscriptEntry[] = [
      customerSays(1, ["my roof leaks", "since yesterday"]),
      botSays(1, ["Sorry to hear that. <b>What's the ZIP code?</b>"]),
    ];
    const messages = customerMessages(entries, false);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[1]?.content).toBe("my roof leaks\n---\nsince yesterday");
    // Markup in a bot reply cannot close the tag it is shown in.
    expect(messages[2]?.content).toContain("‹b›What's the ZIP code?‹/b›");
    expect(messages[2]?.content).toContain("<assistant_message>");
  });

  it("tells the customer when the bot stayed silent and when a day has passed", () => {
    const entries: TranscriptEntry[] = [customerSays(1, ["hello?"]), botSays(1, [])];
    expect(customerMessages(entries, false).at(-1)?.content).toContain(
      "The assistant did not answer.",
    );
    expect(
      customerMessages(
        [...entries, botSays(1, ["Still there?"], { trigger: "follow_up" })],
        true,
      ).at(-1)?.content,
    ).toContain("About a day has passed");
  });
});

describe("createCustomerSimulator", () => {
  const entries: TranscriptEntry[] = [
    customerSays(1, scenario.instance.opening),
    botSays(1, ["What's the ZIP code?"]),
  ];
  const input = { scenario, entries, returning: false, photoSent: false, trace };

  it("asks the model with the persona as a cached system prompt and returns its move", async () => {
    const model = createScriptedModelClient([
      scriptedResponse([text("80226\n---\ncan someone come this week?")]),
    ]);
    const simulator = createCustomerSimulator({
      client: model,
      model: "claude-opus-5-5",
      effort: "low",
      logger,
    });
    const calls: CallSummary[] = [];
    const move = await simulator.next({ ...input, calls });
    expect(move).toEqual({
      messages: ["80226", "can someone come this week?"],
      photo: false,
      leave: null,
      replaced: false,
    });
    const request = model.requests[0];
    expect(request).toMatchObject({
      purpose: "eval_customer",
      model: "claude-opus-5-5",
      effort: "low",
      fallbacks: true,
    });
    expect(request?.system[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(request?.tools).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ purpose: "eval_customer", stopReason: "end_turn" });
  });

  it("gives a cut-off answer more room once, then lets the stand-in write the line", async () => {
    const model = createScriptedModelClient([
      scriptedResponse([text("it's 802")], { stopReason: "max_tokens" }),
      scriptedResponse([text("it's 80226")]),
    ]);
    const simulator = createCustomerSimulator({ client: model, model: "m", effort: "low", logger });
    const move = await simulator.next({ ...input, calls: [] });
    expect(move.messages).toEqual(["it's 80226"]);
    expect(model.requests[1]?.maxTokens).toBe((model.requests[0]?.maxTokens ?? 0) * 2);
  });

  it("falls back to the stand-in for one line when the model declines, and says so", async () => {
    const model = createScriptedModelClient([scriptedRefusal("cyber")]);
    const simulator = createCustomerSimulator({ client: model, model: "m", effort: "low", logger });
    const move = await simulator.next({ ...input, calls: [] });
    expect(move.replaced).toBe(true);
    expect(move.messages.join(" ")).toContain(scenario.instance.truth.zip);
  });
});

describe("the stand-in customer", () => {
  const hints = (entries: TranscriptEntry[], who = scenario, returning = false) =>
    customerHints(who, entries, returning, false);

  it("answers what the bot asked with the persona's own facts", () => {
    const move = standInMove(
      hints([
        customerSays(1, ["leak"]),
        botSays(1, ["What's the ZIP code of the property? Do you own the home?"]),
      ]),
    );
    expect(move).toContain(scenario.instance.truth.zip);
    expect(move).toContain("We own the house.");
  });

  it("asks the persona's own questions when nothing is open, then says goodbye", () => {
    const asked = standInMove(hints([customerSays(1, ["leak"]), botSays(1, ["Thanks, noted."])]));
    expect(asked).toBe("How soon could someone actually come out?");
    const done = standInMove(
      hints([
        customerSays(1, [
          "leak",
          "How soon could someone actually come out?",
          "Are you guys licensed and insured?",
        ]),
        botSays(1, ["Someone from the team will reach out within one business day."]),
      ]),
    );
    expect(done).toBe("No, that's all. Thank you!\n[end: satisfied]");
  });

  it("plays the characters: one word, no phone yet, pushing back once, leaving when ignored", () => {
    const terse = scenarioWith({ persona: "one_word" });
    expect(
      standInMove(
        hints(
          [customerSays(1, ["leak"]), botSays(1, ["What's the ZIP code? Do you own the home?"])],
          terse,
        ),
      ),
    ).toBe(terse.instance.truth.zip);
    const shopper = scenarioWith({ persona: "price_shopper" });
    expect(
      standInMove(
        hints(
          [customerSays(1, ["price?"]), botSays(1, ["What's the best phone number?"])],
          shopper,
        ),
      ),
    ).toBe("I'd rather not get calls yet.");
    const far = scenarioWith({ persona: "out_of_area" });
    const declined = [
      customerSays(1, ["leak"]),
      botSays(1, ["I'm sorry, that's outside our service area."]),
    ];
    expect(standInMove(hints(declined, far))).toBe("Are you sure? It's really not that far.");
    expect(
      standInMove(
        hints(
          [
            ...declined,
            customerSays(2, ["Are you sure? It's really not that far."]),
            botSays(2, ["Yes, sorry: it is outside our service area."]),
          ],
          far,
        ),
      ),
    ).toContain("[end: turned_away]");
    expect(standInMove(hints([customerSays(1, ["leak"]), botSays(1, [])]))).toBe("[end: gave_up]");
    expect(
      standInMove(
        hints([customerSays(1, ["leak"]), botSays(1, ["What's the ZIP code?"])], scenario, true),
      ),
    ).toContain("sorry, got pulled into something yesterday");
  });

  it("is a model client that only answers the simulator", async () => {
    const client = createStandInCustomerModel();
    const simulator = createCustomerSimulator({ client, model: "stand-in", effort: "low", logger });
    const calls: CallSummary[] = [];
    const move = await simulator.next({
      scenario,
      entries: [customerSays(1, ["leak"]), botSays(1, ["What's the ZIP code?"])],
      returning: false,
      photoSent: false,
      trace,
      calls,
    });
    expect(move.messages[0]).toContain(scenario.instance.truth.zip);
    expect(move.replaced).toBe(false);
    expect(calls[0]?.model).toBe("stand-in-customer-1");
    await expect(
      client.call({
        purpose: "reply",
        model: "x",
        effort: "low",
        maxTokens: 10,
        system: [],
        messages: [],
      }),
    ).rejects.toThrow(/only answers requests of the customer simulator/);
  });
});
