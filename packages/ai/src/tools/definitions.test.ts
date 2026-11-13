import { describe, expect, it } from "vitest";

import { EngineAction } from "@repo/core";

import { ENGINE_TOOLS, findEngineTool, modelTools } from "./definitions";

const VALID: Readonly<Record<string, unknown>> = {
  analyze_photos: { attachment_ids: ["att-1"], question: "Where is the stain?" },
  book_meeting: { slot_id: "slot-1" },
  end_conversation: { reason: "Customer said goodbye.", disposition: "completed" },
  escalate_emergency: { emergency_class: "gas_leak", summary: "Smells gas near the furnace." },
  handoff_to_human: { reason: "Asked for the owner.", urgency: "normal" },
  mark_not_a_fit: { category: "spam", reason: "Bulk advertising." },
  offer_times: { preference: null, count: 3 },
  request_photo: { subject: "the label on the unit" },
  schedule_follow_up: { after: "PT4H", reason: "Checking with a spouse." },
  update_lead_fields: {
    fields: [
      { key: "timeline", value: "this_week", confidence: 0.9, evidence: "by Friday" },
      { key: "budget_usd", value: 4000, confidence: 1, evidence: null },
      { key: "referral", value: true, confidence: 1, evidence: "" },
      { key: "service_area", value: null, confidence: 0, evidence: null },
    ],
  },
};

describe("engine tools", () => {
  it("has one tool per action of the contract", () => {
    const names = ENGINE_TOOLS.map((tool) => tool.name).sort();
    const actions = EngineAction.options.map((option) => option.shape.type.value).sort();
    expect(names).toEqual(actions);
  });

  it.each(Object.entries(VALID))(
    "%s maps a valid input to an action the contract accepts",
    (name, input) => {
      const tool = findEngineTool(name);
      expect(tool).toBeDefined();
      const action = tool!.toAction(input);
      expect(action.type).toBe(name);
      expect(EngineAction.safeParse(action).success).toBe(true);
    },
  );

  it("maps the tool's field names to the contract's", () => {
    expect(findEngineTool("escalate_emergency")!.toAction(VALID["escalate_emergency"])).toEqual({
      type: "escalate_emergency",
      emergencyClass: "gas_leak",
      summary: "Smells gas near the furnace.",
    });
    expect(findEngineTool("offer_times")!.toAction({ preference: "  ", count: 2 })).toEqual({
      type: "offer_times",
      preference: null,
      count: 2,
    });
    expect(
      findEngineTool("update_lead_fields")!.toAction(VALID["update_lead_fields"]),
    ).toMatchObject({
      fields: [
        { key: "timeline", evidence: "by Friday" },
        { key: "budget_usd", value: 4000 },
        // An empty evidence string is the same as none.
        { key: "referral", evidence: null },
        { key: "service_area", value: null },
      ],
    });
  });

  it("checks what strict mode cannot: ranges, lengths and formats", () => {
    const bad: [string, unknown][] = [
      ["offer_times", { preference: null, count: 0 }],
      ["offer_times", { preference: null, count: 6 }],
      ["offer_times", { preference: null, count: 2.5 }],
      ["update_lead_fields", { fields: [] }],
      [
        "update_lead_fields",
        { fields: [{ key: "timeline", value: "x", confidence: 1.5, evidence: null }] },
      ],
      ["update_lead_fields", { fields: [{ key: "", value: "x", confidence: 1, evidence: null }] }],
      [
        "update_lead_fields",
        { fields: [{ key: "k", value: { nested: 1 }, confidence: 1, evidence: null }] },
      ],
      ["schedule_follow_up", { after: "tomorrow", reason: "x" }],
      ["schedule_follow_up", { after: "P", reason: "x" }],
      ["schedule_follow_up", { after: "PT", reason: "x" }],
      ["handoff_to_human", { reason: "x", urgency: "extreme" }],
      ["mark_not_a_fit", { category: "boring", reason: "x" }],
      ["end_conversation", { reason: "  ", disposition: "completed" }],
      ["analyze_photos", { attachment_ids: [], question: "x" }],
      ["request_photo", {}],
      ["book_meeting", "slot-1"],
    ];
    for (const [name, input] of bad) {
      expect(
        () => findEngineTool(name)!.toAction(input),
        `${name} ${JSON.stringify(input)}`,
      ).toThrow();
    }
    for (const after of ["PT30M", "P1D", "P1DT12H", "P2W", "PT90S"]) {
      expect(findEngineTool("schedule_follow_up")!.toAction({ after, reason: "x" })).toMatchObject({
        after,
      });
    }
  });

  it("can be sent without strict mode, with the same schemas", () => {
    const strict = modelTools({ strict: true });
    const loose = modelTools({ strict: false });
    expect(loose.map((tool) => tool.input_schema)).toEqual(strict.map((tool) => tool.input_schema));
    expect(loose.every((tool) => !("strict" in tool))).toBe(true);
  });
});
