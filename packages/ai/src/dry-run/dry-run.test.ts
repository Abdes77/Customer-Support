import { describe, expect, it } from "vitest";

import type { EngineAction, LeadSnapshot, ToolExecutionContext } from "@repo/core";
import { settingsWith } from "@repo/settings";

import { createEngine } from "../engine/engine";
import { createScriptedModelClient, scriptedResponse, text, toolUse } from "../model/scripted";
import { testBusiness, testInput } from "../testing/fixtures";
import {
  createDryRunConversation,
  createDryRunPorts,
  dryRunTurn,
  placeholderRouting,
  staticKnowledge,
} from "./dry-run";

const settings = settingsWith({});

function leadWith(keys: readonly string[]): LeadSnapshot {
  return {
    id: null,
    status: "qualifying",
    routing: null,
    fields: Object.fromEntries(
      keys.map((key) => [
        key,
        { key, value: "x", confidence: 1, evidence: null, updatedAt: "2026-11-10T17:00:00.000Z" },
      ]),
    ),
  };
}

describe("dryRunTurn (invariant I8)", () => {
  it("runs the engine in dry-run mode whatever the input says, and tells every handler", async () => {
    const seen: { action: EngineAction; context: ToolExecutionContext }[] = [];
    const ports = createDryRunPorts({
      tools: {
        execute: async (action, context) => {
          seen.push({ action, context });
          return { status: "applied", message: null, data: null };
        },
      },
    });
    const model = createScriptedModelClient([
      scriptedResponse([toolUse("request_photo", { subject: "the ceiling" })]),
      scriptedResponse([text("Could you send a photo of the ceiling?")]),
    ]);
    const { business } = testBusiness();
    const result = await dryRunTurn(
      createEngine({ model }),
      testInput({ business, mode: "live" }),
      ports,
    );
    expect(result.outcome).toBe("replied");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.context.mode).toBe("dry_run");
    // The engine has no side effects of its own: everything it did went through the ports.
    expect(ports.modelCallLog).toHaveLength(2);
    expect(ports.modelCallLog.every((call) => call.purpose === "reply")).toBe(true);
  });
});

describe("placeholderRouting", () => {
  it("decides nothing while a required criterion is unknown", () => {
    expect(
      placeholderRouting(
        leadWith(["service_type", "job_scope", "service_area"]),
        settings,
        "2026-11-10T17:00:00.000Z",
      ),
    ).toBeNull();
  });

  it("scores from the weights and routes by the band's outcome", () => {
    const required = ["service_type", "job_scope", "service_area", "timeline"];
    const decision = placeholderRouting(leadWith(required), settings, "2026-11-10T17:00:00.000Z");
    // 65 of 95 points known, half credit for the 30 unknown: 80 / 95.
    expect(decision).toMatchObject({
      score: 84,
      band: "hot",
      outcome: "book_meeting",
      settingsVersion: settings.version,
    });
    const everyone = settingsWith({ "routing.mode": "always_contact_later" });
    expect(
      placeholderRouting(leadWith(required), everyone, "2026-11-10T17:00:00.000Z")?.outcome,
    ).toBe("contact_later");
    const strict = settingsWith({
      "scoring.unknown_credit_percent": 0,
      "scoring.thresholds": { hot: 90, warm: 70 },
    });
    expect(
      placeholderRouting(leadWith(required), strict, "2026-11-10T17:00:00.000Z"),
    ).toMatchObject({
      score: 68,
      band: "cold",
      outcome: "contact_later",
    });
  });
});

describe("createDryRunConversation", () => {
  it("keeps history, lead record and clock from turn to turn", async () => {
    const { business, facts } = testBusiness("roofing");
    const model = createScriptedModelClient([
      scriptedResponse([
        toolUse("update_lead_fields", {
          fields: [{ key: "service_type", value: "roof repair", confidence: 1, evidence: null }],
        }),
      ]),
      scriptedResponse([text("Sorry about the leak! What's the ZIP code?")]),
      scriptedResponse([text("Thanks!")]),
    ]);
    const conversation = createDryRunConversation({
      engine: createEngine({ model }),
      business,
      facts,
      settings,
    });
    const first = await conversation.customerSays("My roof leaks");
    expect(first.input.history).toEqual([]);
    expect(first.input.lead.status).toBe("new");
    expect(first.modelCalls).toHaveLength(2);

    const second = await conversation.customerSays(["80215", "sorry, 80214"], { afterMinutes: 3 });
    expect(second.input.history.map((turn) => [turn.author, turn.text])).toEqual([
      ["customer", "My roof leaks"],
      [
        "bot",
        "I'm Alex, the virtual assistant for Summit Roofing Co. Sorry about the leak! What's the ZIP code?",
      ],
    ]);
    expect(second.input.pending.map((turn) => turn.text)).toEqual(["80215", "sorry, 80214"]);
    expect(second.input.lead.fields["service_type"]?.value).toBe("roof repair");
    expect(Date.parse(second.input.now) - Date.parse(first.input.now)).toBe(180_000);
    expect(conversation.history).toHaveLength(5);
    expect(conversation.state.actions).toHaveLength(1);
  });

  it("looks facts up by the words of the question", async () => {
    const { facts } = testBusiness("roofing");
    const knowledge = staticKnowledge(facts);
    const found = await knowledge.retrieve({
      businessId: testBusiness().business.id,
      text: "What warranty do you give on workmanship?",
      limit: 2,
    });
    expect(found[0]?.id).toBe("roof-warranty");
    expect(found.length).toBeLessThanOrEqual(2);
    expect(await knowledge.coreFacts(testBusiness().business.id)).toEqual(facts);
  });
});
