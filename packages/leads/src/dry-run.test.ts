import { describe, expect, it } from "vitest";

import { createDryRunConversation, createEngine, createMemoryToolRuntime } from "@repo/ai";
import {
  createScriptedModelClient,
  scriptedResponse,
  testBusiness,
  text,
  toolUse,
} from "@repo/ai/testing";
import { settingsWith } from "@repo/settings";

import { leadRouting, withLeadScoring } from "./dry-run";

/**
 * The real rules in a dry run (what the evaluation harness, C7, plugs in): the routing
 * decision the model reads in the tool result is the one production would make.
 */
describe("lead scoring in dry runs", () => {
  it("routes an HVAC lead with the real rules and keeps the lead record in memory", async () => {
    const model = createScriptedModelClient();
    const settings = settingsWith({});
    const { business, facts } = testBusiness("hvac");
    const conversation = createDryRunConversation({
      engine: createEngine({ model }),
      business,
      facts,
      settings,
      tools: (state) =>
        withLeadScoring(
          state,
          settings,
          createMemoryToolRuntime({ state, settings, routing: leadRouting }),
        ),
    });
    model.push(
      scriptedResponse([
        toolUse("update_lead_fields", {
          fields: [
            { key: "service_type", value: "AC repair", confidence: 1, evidence: "AC died" },
            {
              key: "job_scope",
              value: "Central AC not cooling",
              confidence: 1,
              evidence: "not cooling",
            },
            { key: "service_area", value: "98103", confidence: 1, evidence: "98103" },
            { key: "timeline", value: "this_week", confidence: 1, evidence: "this week" },
            { key: "decision_maker", value: "tenant", confidence: 1, evidence: "I rent" },
          ],
        }),
      ]),
      scriptedResponse([text("Thanks! Who owns the place, so the team can line it up with them?")]),
    );
    await conversation.customerSays("My AC died, I rent in 98103, need it fixed this week");

    // A renter: the decision-maker rule sends the lead to the team instead of booking it.
    expect(conversation.state.lead.routing).toMatchObject({
      outcome: "contact_later",
      band: "hot",
    });
    expect(conversation.state.lead.status).toBe("qualified");
    const toolResult = JSON.stringify(model.requests.at(-1)?.messages.at(-1));
    expect(toolResult).toContain("Routing decision: contact_later.");
    expect(conversation.state.actions.map((entry) => entry.outcome.status)).toEqual(["applied"]);
  });

  it("gives the same decision as `leadRouting` for a snapshot", () => {
    const settings = settingsWith({ "routing.mode": "always_contact_later" });
    const decision = leadRouting(
      {
        id: null,
        status: "qualifying",
        fields: Object.fromEntries(
          ["service_type", "job_scope", "service_area", "timeline"].map((key) => [
            key,
            {
              key,
              value: key === "timeline" ? "this_week" : "x",
              confidence: 1,
              evidence: null,
              updatedAt: "2026-11-12T00:00:00.000Z",
            },
          ]),
        ),
        routing: null,
      },
      settings,
      "2026-11-12T00:00:00.000Z",
    );
    expect(decision?.outcome).toBe("contact_later");
  });
});
