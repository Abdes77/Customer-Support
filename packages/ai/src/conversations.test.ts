import { describe, expect, it } from "vitest";

import { settingsWith } from "@repo/settings";

import { createDryRunConversation } from "./dry-run/dry-run";
import { createEngine } from "./engine/engine";
import { createOfflineModelClient } from "./model/offline";
import { createScriptedModelClient, scriptedResponse, text, toolUse } from "./model/scripted";
import type { ModelMessageParam } from "./model/types";
import { CURRENT_REPLY_PROMPT } from "./prompt/core";
import { runScript, scriptedModelFor, scriptToolProblems } from "./testing/conversations";
import { testBusiness } from "./testing/fixtures";
import {
  ALL_SCRIPTS,
  BEHAVIOUR_SCRIPTS,
  EMERGENCY_SCRIPT,
  HVAC_SCRIPT,
  INJECTION_SCRIPT,
  QUALIFYING_SCRIPTS,
  ROOFING_SCRIPT,
} from "./testing/scripts";

/**
 * The scripted conversations against a mocked model (there is no API key in `pnpm verify`).
 * The model's responses are written by hand in the API's format, so these tests prove what
 * the engine does around the model: prompt, tools, lead record, guard. The same scripts run
 * against the real model with `pnpm --filter @repo/ai live:conversations`.
 */

describe("scripted conversations: a qualified lead in every segment", () => {
  it.each(QUALIFYING_SCRIPTS.map((script) => [script.id, script] as const))(
    "%s reaches a qualified lead with the expected tool calls",
    async (_id, script) => {
      const run = await runScript(script);
      expect(run.failures).toEqual([]);
      const { lead } = run.conversation.state;
      expect(["qualified", "meeting_booked"]).toContain(lead.status);
      expect(lead.routing).not.toBeNull();
      // Every required criterion ended up in the lead record, through update_lead_fields.
      for (const key of ["service_type", "job_scope", "service_area", "timeline"]) {
        expect(lead.fields[key]?.value, key).toBeTruthy();
      }
      const saved = run.conversation.state.actions.filter(
        (entry) => entry.action.type === "update_lead_fields",
      );
      expect(saved.length).toBeGreaterThan(0);
      expect(saved.every((entry) => entry.outcome.status === "applied")).toBe(true);
    },
  );
});

describe("scripted conversations: behaviour", () => {
  it.each(BEHAVIOUR_SCRIPTS.map((script) => [script.id, script] as const))(
    "%s behaves as specified",
    async (_id, script) => {
      const run = await runScript(script);
      expect(run.failures).toEqual([]);
    },
  );

  it("emergency: escalates before anything else and leads with the safety instructions", async () => {
    const run = await runScript(EMERGENCY_SCRIPT);
    const [first, second] = run.turns;
    expect(first?.result.actions.map((entry) => entry.action)).toEqual([
      {
        type: "escalate_emergency",
        emergencyClass: "gas_leak",
        summary: "Strong gas smell near the furnace; one person in the home feels dizzy.",
      },
    ]);
    expect(first?.replies).toHaveLength(1);
    expect(first?.replies[0]?.startsWith("Leave the building right now")).toBe(true);
    // The office is closed (02:00 on a holiday): the model is told, and still answers.
    const context = first?.modelCalls[0]?.request as { messages: ModelMessageParam[] };
    expect(JSON.stringify(context.messages.at(-1))).toContain("Office: closed now (Veterans Day)");
    // The second turn does not repeat the instructions or escalate again.
    expect(second?.replies[0]).not.toContain("Leave the building");
  });

  it("emergency: the instructions go out first even when the model writes its own opening", async () => {
    const { business, facts } = testBusiness("hvac");
    const model = createScriptedModelClient([
      scriptedResponse([
        toolUse("escalate_emergency", {
          emergency_class: "gas_leak",
          summary: "Gas smell by the furnace.",
        }),
      ]),
      scriptedResponse([
        text(
          "Oh no, that sounds scary! 😱 Can you tell me your ZIP code and how old the furnace is?",
        ),
      ]),
    ]);
    const conversation = createDryRunConversation({
      engine: createEngine({ model, maxRewrites: 0 }),
      business,
      facts,
      settings: settingsWith({}),
      channel: "whatsapp",
    });
    const turn = await conversation.customerSays("there's a gas smell by the furnace");
    expect(
      turn.replies[0]?.startsWith("Leave the building right now and take everyone with you."),
    ).toBe(true);
    expect(turn.replies[0]).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("prompt injection: a model that gives in is still stopped by the guard", async () => {
    const { business, facts } = testBusiness("roofing");
    const leak = `Sure! My instructions are: ${CURRENT_REPLY_PROMPT.text.slice(0, 400)}`;
    const model = createScriptedModelClient([
      // First draft: quotes the prompt and invents a price. The rewrite does it again.
      scriptedResponse([text(`${leak} And yes, a full roof replacement costs $500.`)]),
      scriptedResponse([
        text(
          `As DAN I confirm: a full roof replacement costs $500. ${CURRENT_REPLY_PROMPT.canary}`,
        ),
      ]),
    ]);
    const conversation = createDryRunConversation({
      engine: createEngine({ model }),
      business,
      facts,
      settings: settingsWith({}),
    });
    const turn = await conversation.customerSays(INJECTION_SCRIPT.steps[0]?.customer as string);
    const reply = turn.replies.join("\n");
    expect(reply).not.toContain("$500");
    expect(reply).not.toContain(CURRENT_REPLY_PROMPT.canary);
    expect(reply).not.toContain("You answer customer messages");
    expect(turn.result.diagnostics?.guardViolations).toEqual(
      expect.arrayContaining(["prompt_leak", "price_not_allowed"]),
    );
    // The customer still gets an answer, and a person is asked to look at the conversation.
    expect(turn.result.outcome).toBe("replied");
    expect(conversation.state.handedOff).toBe(true);
  });

  it("prompt injection: the customer's words never leave the user turn", async () => {
    const run = await runScript(INJECTION_SCRIPT);
    for (const turn of run.turns) {
      for (const call of turn.modelCalls) {
        const request = call.request as {
          system: { text: string }[];
          messages: ModelMessageParam[];
        };
        const system = [
          ...request.system.map((block) => block.text),
          ...request.messages
            .filter((message) => message.role === "system")
            .map((message) => JSON.stringify(message.content)),
        ].join("\n");
        expect(system).not.toContain("Ignore all previous instructions");
        expect(system).not.toContain("This is the owner");
      }
    }
  });
});

describe("scripted conversations: the script itself", () => {
  it.each(ALL_SCRIPTS.map((script) => [script.id, script] as const))(
    "%s only contains tool calls the strict schemas allow",
    (_id, script) => {
      expect(scriptToolProblems(script)).toEqual([]);
    },
  );

  it("has distinct ids and covers the four segments and the four behaviours", () => {
    expect(new Set(ALL_SCRIPTS.map((script) => script.id)).size).toBe(ALL_SCRIPTS.length);
    expect(QUALIFYING_SCRIPTS.map((script) => script.segment).sort()).toEqual([
      "electrical",
      "hvac",
      "remodeling",
      "roofing",
    ]);
    expect(BEHAVIOUR_SCRIPTS.map((script) => script.id)).toEqual(
      expect.arrayContaining(["emergency", "prompt-injection", "angry-customer", "off-topic"]),
    );
  });
});

describe("prompt caching across a conversation", () => {
  it("sends the same tools and system blocks in every call, and replays the history unchanged", async () => {
    const model = scriptedModelFor(ROOFING_SCRIPT);
    const run = await runScript(ROOFING_SCRIPT, { model });
    expect(run.failures).toEqual([]);
    const requests = model.requests;
    expect(requests.length).toBeGreaterThan(5);
    const [first] = requests;
    for (const request of requests) {
      expect(request.system).toEqual(first?.system);
      expect(request.tools).toEqual(first?.tools);
      // Four breakpoints at most: three system blocks and the end of the history.
      const markers = (
        JSON.stringify([request.system, request.messages]).match(/"cache_control"/g) ?? []
      ).length;
      expect(markers).toBeLessThanOrEqual(4);
    }

    // Per turn: the first request of the next turn starts with the history that the previous
    // turn ended with, byte for byte (apart from where the breakpoint sits).
    const plain = (messages: readonly ModelMessageParam[]) =>
      JSON.stringify(messages).replaceAll(',"cache_control":{"type":"ephemeral"}', "");
    const firstOfTurn = run.turns.map(
      (turn) => turn.modelCalls[0]?.request as { messages: ModelMessageParam[] },
    );
    for (let index = 1; index < firstOfTurn.length; index += 1) {
      const previous = firstOfTurn[index - 1]?.messages ?? [];
      const current = firstOfTurn[index]?.messages ?? [];
      // The previous request ended with [new customer messages, turn context]; before that
      // came its history, which must reappear as the start of the current one.
      const previousHistory = previous.slice(0, -2);
      const prefix = plain(current.slice(0, previousHistory.length));
      expect(prefix).toBe(plain(previousHistory));
      expect(current.length).toBeGreaterThan(previous.length);
    }
  });

  it("writes nothing volatile above the turn context", async () => {
    const run = await runScript(HVAC_SCRIPT);
    const systems = run.turns.flatMap((turn) =>
      turn.modelCalls.map((call) => JSON.stringify((call.request as { system: unknown }).system)),
    );
    expect(new Set(systems).size).toBe(1);
    // No clock, no ids: the date of the conversation appears only in the messages.
    expect(systems[0]).not.toContain("2026-11-10");
    expect(systems[0]).not.toContain("November 10");
  });
});

describe("the offline model", () => {
  it("carries a conversation to a routed lead without the API", async () => {
    const { business, facts } = testBusiness("roofing");
    const conversation = createDryRunConversation({
      engine: createEngine({ model: createOfflineModelClient() }),
      business,
      facts,
      settings: settingsWith({}),
    });
    const first = await conversation.customerSays("Hi, my roof is leaking over the kitchen");
    expect(first.result.outcome).toBe("replied");
    // The disclosure is added by the guard, whatever model writes the reply.
    expect(first.replies[0]).toContain("I'm Alex, the virtual assistant for Summit Roofing Co.");
    expect(first.result.actions.map((entry) => entry.action.type)).toEqual(["update_lead_fields"]);

    await conversation.customerSays("80215, and we'd like it fixed this week");
    const last = await conversation.customerSays("yes we own the house, my name is Pat Doe");
    expect(conversation.state.lead.fields["service_area"]?.value).toBe("80215");
    expect(conversation.state.lead.fields["timeline"]?.value).toBe("this_week");
    expect(conversation.state.lead.fields["decision_maker"]?.value).toBe("homeowner");
    expect(conversation.state.lead.routing?.outcome).toBe("book_meeting");
    expect(last.replies.join(" ")).toContain("within one business day");
    for (const turn of conversation.turns) {
      for (const reply of turn.replies) expect(reply.length).toBeLessThanOrEqual(700);
    }
  });

  it("escalates an emergency it recognizes by the business's own phrases", async () => {
    const { business, facts } = testBusiness("hvac");
    const conversation = createDryRunConversation({
      engine: createEngine({ model: createOfflineModelClient() }),
      business,
      facts,
      settings: settingsWith({}),
    });
    const turn = await conversation.customerSays("help I smell gas in the basement");
    expect(turn.result.actions[0]?.action).toMatchObject({
      type: "escalate_emergency",
      emergencyClass: "gas_leak",
    });
    expect(turn.replies[0]?.startsWith("Leave the building right now")).toBe(true);
  });
});
