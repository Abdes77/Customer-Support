import { describe, expect, it } from "vitest";

import {
  type ActionOutcome,
  ConfigError,
  createLogger,
  type EngineAction,
  type EnginePorts,
  type EngineTurnInput,
  ExternalServiceError,
  type KnowledgeFact,
  type ModelCallRecord,
  type ToolExecutionContext,
} from "@repo/core";
import { type AppSettings, settingsWith } from "@repo/settings";

import {
  createScriptedModelClient,
  type ScriptedStep,
  scriptedRefusal,
  scriptedResponse,
  text,
  thinking,
  toolUse,
} from "../model/scripted";
import type { ModelMessageParam, ModelRequest } from "../model/types";
import { PROMPT_VERSION } from "../prompt/core";
import { testBusiness, testInput, type TestInputOptions, testTurn } from "../testing/fixtures";
import { createEngine, type EngineOptions } from "./engine";

const GAS_INSTRUCTIONS =
  "Leave the building right now and take everyone with you. Don't use light switches, appliances or anything that could spark on the way out. Once you are outside, call 911 or your gas utility's emergency line.";

interface Harness {
  readonly result: Awaited<ReturnType<ReturnType<typeof createEngine>["respond"]>>;
  readonly requests: ModelRequest[];
  readonly executed: { action: EngineAction; context: ToolExecutionContext }[];
  readonly records: ModelCallRecord[];
  readonly input: EngineTurnInput;
}

interface RunOptions extends Omit<TestInputOptions, "settings"> {
  readonly settings?: Partial<AppSettings>;
  readonly outcomes?: (action: EngineAction) => ActionOutcome | undefined;
  readonly facts?: readonly KnowledgeFact[];
  readonly retrieve?: EnginePorts["knowledge"]["retrieve"];
  readonly engine?: Partial<EngineOptions>;
}

const applied: ActionOutcome = { status: "applied", message: null, data: null };

async function run(steps: readonly ScriptedStep[], options: RunOptions = {}): Promise<Harness> {
  const { business, facts } = testBusiness("roofing");
  const model = createScriptedModelClient(steps);
  const executed: Harness["executed"] = [];
  const records: ModelCallRecord[] = [];
  const settings = settingsWith(options.settings ?? {});
  // An earlier exchange by default, so first-reply rules do not get in the way.
  const history = options.history ?? [
    testTurn("customer", "Hi there", "2026-11-10T16:50:00.000Z"),
    testTurn("bot", "Hi! How can I help?", "2026-11-10T16:50:10.000Z"),
  ];
  const input = testInput({ business, ...options, settings, history });
  const ports: EnginePorts = {
    knowledge: {
      coreFacts: async () => options.facts ?? facts,
      retrieve: options.retrieve ?? (async () => []),
    },
    tools: {
      execute: async (action, context) => {
        executed.push({ action, context });
        return options.outcomes?.(action) ?? applied;
      },
    },
    modelCalls: { record: async (call) => void records.push(call) },
    logger: createLogger({ level: "error", sink: () => {} }),
  };
  const engine = createEngine({ model, ...options.engine });
  const result = await engine.respond(input, ports);
  return { result, requests: model.requests, executed, records, input };
}

function lastText(message: ModelMessageParam | undefined): string {
  if (message === undefined) return "";
  if (typeof message.content === "string") return message.content;
  return (message.content ?? [])
    .map((block) =>
      block.type === "text"
        ? block.text
        : block.type === "tool_result" && typeof block.content === "string"
          ? block.content
          : "",
    )
    .join("\n");
}

const routingDecision = {
  outcome: "contact_later" as const,
  score: 64,
  band: "warm",
  reasons: ["Every required criterion is known."],
  decidedAt: "2026-11-10T17:00:00.000Z",
  settingsVersion: "v",
};

describe("a turn without tools", () => {
  it("returns the model's text as one chat message, with the versions and the usage", async () => {
    const { result, requests, records, input } = await run([
      scriptedResponse([thinking(), text("Sorry about the leak! Is water coming in right now?")], {
        usage: { inputTokens: 300, outputTokens: 40, cacheReadInputTokens: 9000 },
      }),
    ]);
    expect(result).toMatchObject({
      outcome: "replied",
      replies: [{ kind: "text", text: "Sorry about the leak! Is water coming in right now?" }],
      actions: [],
      promptVersion: PROMPT_VERSION,
      settingsVersion: input.settings.version,
      usage: { inputTokens: 300, outputTokens: 40, cacheReadInputTokens: 9000 },
      diagnostics: { modelCalls: 1, toolRounds: 0, rewrites: 0, deterministicReply: false },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      purpose: "reply",
      model: "claude-fable-5-2",
      effort: "medium",
      maxTokens: 16_000,
      toolChoice: "auto",
      fallbacks: true,
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ purpose: "reply", promptVersion: PROMPT_VERSION });
  });

  it("takes model, effort, output room and fallbacks from the settings", async () => {
    const { requests } = await run([scriptedResponse([text("Hi.")])], {
      settings: {
        "model.reply.model": "claude-opus-5-5",
        "model.reply.effort": "high",
        "model.reply_max_output_tokens": 8000,
        "model.server_side_fallbacks": false,
      },
    });
    expect(requests[0]).toMatchObject({
      model: "claude-opus-5-5",
      effort: "high",
      maxTokens: 8000,
      fallbacks: false,
    });
  });

  it("writes an email as one email draft with its subject", async () => {
    const { result } = await run(
      [
        scriptedResponse([
          text(
            "<subject>Your roof leak</subject>\nHi Pat,\n\nThanks for the details.\n\nBest,\nAlex",
          ),
        ]),
      ],
      { channel: "email" },
    );
    expect(result.replies).toEqual([
      {
        kind: "email",
        subject: "Your roof leak",
        text: "Hi Pat,\n\nThanks for the details.\n\nBest,\nAlex",
      },
    ]);
  });

  it("splits separate chat messages and puts quick replies on the last one", async () => {
    const { result } = await run([
      scriptedResponse([
        text(
          "Got it, thanks!\n<next_message/>\nDo you own the home?\n<quick_replies>Yes | No</quick_replies>",
        ),
      ]),
    ]);
    expect(result.replies).toEqual([
      { kind: "text", text: "Got it, thanks!" },
      { kind: "text", text: "Do you own the home?", quickReplies: ["Yes", "No"] },
    ]);
  });

  it("stays silent when the model says so, and does not call the model when nothing is due", async () => {
    const silent = await run([scriptedResponse([text("<no_reply/>")])]);
    expect(silent.result).toMatchObject({ outcome: "no_reply", replies: [] });
    const nothing = await run([], { pending: [] });
    expect(nothing.result.outcome).toBe("no_reply");
    expect(nothing.requests).toHaveLength(0);
  });

  it("puts the turn context into the user turn for a model without a system channel", async () => {
    const { requests } = await run([scriptedResponse([text("Hi.")])], {
      settings: { "model.reply.model": "claude-sonnet-5" },
    });
    const messages = requests[0]?.messages ?? [];
    expect(messages.some((message) => message.role === "system")).toBe(false);
    expect(lastText(messages.at(-1))).toContain("<turn_context>");
  });
});

describe("the tool loop", () => {
  const save = toolUse(
    "update_lead_fields",
    {
      fields: [
        { key: "service_area", value: "80215", confidence: 1, evidence: "ZIP is 80215" },
        { key: "timeline", value: "This week", confidence: 0.8, evidence: "before the weekend" },
      ],
    },
    "toolu_save",
  );

  it("executes a tool call, returns the outcome with the routing decision, and sends the final text", async () => {
    const { result, requests, executed, input } = await run(
      [
        scriptedResponse([thinking("sig_a"), save]),
        scriptedResponse([
          text("Thanks! Someone from the team will reach out within one business day."),
        ]),
      ],
      {
        outcomes: () => ({
          status: "applied",
          message: "Saved.",
          data: null,
          routing: routingDecision,
        }),
      },
    );
    expect(executed).toHaveLength(1);
    expect(executed[0]?.action).toEqual({
      type: "update_lead_fields",
      fields: [
        { key: "service_area", value: "80215", confidence: 1, evidence: "ZIP is 80215" },
        // The enumerated value is stored in its canonical form.
        { key: "timeline", value: "this_week", confidence: 0.8, evidence: "before the weekend" },
      ],
    });
    // The handler gets the tool-call id as its idempotency key and the turn's own snapshot.
    expect(executed[0]?.context).toMatchObject({
      toolCallId: "toolu_save",
      mode: "dry_run",
      now: input.now,
      trace: input.trace,
    });
    expect(executed[0]?.context.settings).toBe(input.settings);
    expect(executed[0]?.context.channel).toBe(input.channel);
    expect(executed[0]?.context.business).toBe(input.business);

    // Second request: the first one's messages, the assistant turn unchanged (thinking
    // block included), then the tool result.
    const [first, second] = requests;
    expect(second?.messages.slice(0, first?.messages.length)).toEqual(first?.messages);
    const assistant = second?.messages.at(-2);
    expect(assistant).toEqual({
      role: "assistant",
      content: [{ type: "thinking", thinking: "", signature: "sig_a" }, save],
    });
    const toolResult = second?.messages.at(-1);
    expect(toolResult?.role).toBe("user");
    expect(lastText(toolResult)).toContain("status: applied");
    expect(lastText(toolResult)).toContain("Routing decision: contact_later.");
    // The cached prefix is identical between the two requests of the turn.
    expect(second?.system).toEqual(first?.system);
    expect(second?.tools).toEqual(first?.tools);

    expect(result).toMatchObject({
      outcome: "replied",
      actions: [{ toolCallId: "toolu_save", outcome: { status: "applied" } }],
      diagnostics: { modelCalls: 2, toolRounds: 1 },
    });
    expect(result.usage.inputTokens).toBe(240);
  });

  it("runs several tool calls of one response in order and answers them in one message", async () => {
    const { requests, executed } = await run([
      scriptedResponse([
        save,
        toolUse("request_photo", { subject: "the stain on the ceiling" }, "toolu_photo"),
      ]),
      scriptedResponse([text("Could you send a photo of the stain?")]),
    ]);
    expect(executed.map((entry) => entry.action.type)).toEqual([
      "update_lead_fields",
      "request_photo",
    ]);
    const results = requests[1]?.messages.at(-1);
    expect(Array.isArray(results?.content) && results.content.map((block) => block.type)).toEqual([
      "tool_result",
      "tool_result",
    ]);
    expect(lastText(results)).toContain("Add this reminder in your own words");
  });

  it("saves the valid fields and tells the model what was wrong with the others", async () => {
    const { requests, executed } = await run([
      scriptedResponse([
        toolUse("update_lead_fields", {
          fields: [
            { key: "timeline", value: "soonish", confidence: 1, evidence: null },
            { key: "favourite_color", value: "blue", confidence: 1, evidence: null },
            { key: "decision_maker", value: "homeowner", confidence: 1, evidence: "we own it" },
          ],
        }),
      ]),
      scriptedResponse([text("Thanks!")]),
    ]);
    expect(executed[0]?.action).toMatchObject({
      fields: [{ key: "decision_maker", value: "homeowner" }],
    });
    const result = lastText(requests[1]?.messages.at(-1));
    expect(result).toContain("timeline: must be one of: emergency, this_week");
    expect(result).toContain("favourite_color: not a lead field of this business");
  });

  it("does not execute a call whose input is wrong, and reports it as an error", async () => {
    const { requests, executed, result } = await run([
      scriptedResponse([
        toolUse(
          "update_lead_fields",
          { fields: [{ key: "nope", value: 1, confidence: 1, evidence: null }] },
          "t1",
        ),
        toolUse("offer_times", { preference: null, count: 9 }, "t2"),
        toolUse("delete_everything", {}, "t3"),
        toolUse("schedule_follow_up", { after: "in two hours", reason: "spouse" }, "t4"),
      ]),
      scriptedResponse([text("Let me know!")]),
    ]);
    expect(executed).toHaveLength(0);
    expect(result.actions).toHaveLength(0);
    const blocks = requests[1]?.messages.at(-1)?.content;
    expect(
      Array.isArray(blocks) &&
        blocks.map((block) => block.type === "tool_result" && block.is_error),
    ).toEqual([true, true, true, true]);
    const said = lastText(requests[1]?.messages.at(-1));
    expect(said).toContain("No field could be saved.");
    expect(said).toContain("count");
    expect(said).toContain('There is no tool named "delete_everything".');
    expect(said).toContain("must be an ISO 8601 duration");
  });

  it("refuses in code what the settings forbid, without asking the handler", async () => {
    const { executed, result, requests } = await run(
      [
        scriptedResponse([
          toolUse("request_photo", { subject: "the roof" }, "t1"),
          toolUse("analyze_photos", { attachment_ids: ["att-1"], question: "What is it?" }, "t2"),
          toolUse("offer_times", { preference: null, count: 3 }, "t3"),
        ]),
        scriptedResponse([text("The team will be in touch.")]),
      ],
      {
        settings: {
          "photos.request_mode": "never",
          "photos.analysis_enabled": false,
          "routing.mode": "always_contact_later",
        },
      },
    );
    expect(executed).toHaveLength(0);
    // Refused actions are still part of the turn's record.
    expect(result.actions.map((entry) => [entry.action.type, entry.outcome.status])).toEqual([
      ["request_photo", "rejected"],
      ["analyze_photos", "rejected"],
      ["offer_times", "rejected"],
    ]);
    expect(lastText(requests[1]?.messages.at(-1))).toContain("does not book meetings in chat");
  });

  it("only analyzes photos that belong to the conversation", async () => {
    const photo = testTurn("customer", "Here", "2026-11-10T17:00:00.000Z", {
      attachments: [
        { id: "att-1", kind: "image", mimeType: "image/jpeg", storage: { bucket: "b", path: "p" } },
      ],
    });
    const { executed, requests } = await run(
      [
        scriptedResponse([
          toolUse("analyze_photos", { attachment_ids: ["att-999"], question: "?" }, "t1"),
          toolUse(
            "analyze_photos",
            { attachment_ids: ["att-1"], question: "Where is the stain?" },
            "t2",
          ),
        ]),
        scriptedResponse([text("Thanks for the photo!")]),
      ],
      { pending: [photo] },
    );
    expect(executed.map((entry) => entry.action)).toEqual([
      { type: "analyze_photos", attachmentIds: ["att-1"], question: "Where is the stain?" },
    ]);
    expect(lastText(requests[0]?.messages.at(-1))).toContain("Photos not looked at yet: att-1.");
    expect(lastText(requests[1]?.messages.at(-1))).toContain(
      "These are not photos of this conversation: att-999",
    );
  });

  it("turns a failing handler into a failed outcome instead of failing the turn", async () => {
    const { result, requests } = await run(
      [
        scriptedResponse([
          toolUse("handoff_to_human", { reason: "asked for the owner", urgency: "normal" }),
        ]),
        scriptedResponse([text("I've asked the team to get back to you.")]),
      ],
      {
        outcomes: () => {
          throw new Error("database down");
        },
      },
    );
    expect(result.outcome).toBe("replied");
    const block = requests[1]?.messages.at(-1)?.content;
    expect(Array.isArray(block) && block[0]).toMatchObject({ type: "tool_result", is_error: true });
    expect(lastText(requests[1]?.messages.at(-1))).toContain("status: failed");
  });

  it("stops offering tools after the allowed number of rounds", async () => {
    const again = () => scriptedResponse([toolUse("request_photo", { subject: "the roof" })]);
    const { requests, result, executed } = await run(
      [again(), again(), scriptedResponse([text("Could you send a photo?")])],
      { settings: { "model.max_tool_rounds": 2 } },
    );
    expect(executed).toHaveLength(2);
    expect(requests.map((request) => request.toolChoice)).toEqual(["auto", "auto", "none"]);
    expect(lastText(requests[2]?.messages.at(-1))).toContain("No tool can be called any more.");
    // The tools stay in the request so the cached prefix does not change.
    expect(requests[2]?.tools).toEqual(requests[0]?.tools);
    expect(result.outcome).toBe("replied");
    expect(result.diagnostics?.toolRounds).toBe(2);
  });
});

describe("emergencies", () => {
  const escalate = (key: string) =>
    toolUse(
      "escalate_emergency",
      { emergency_class: key, summary: "Smells gas in the basement." },
      "toolu_gas",
    );

  it("escalates, and puts the safety instructions first even when the model did not", async () => {
    const { result, executed, requests } = await run(
      [
        scriptedResponse([escalate("gas_leak")]),
        scriptedResponse([text("Oh no! I've alerted the team 🙏 What's your address?")]),
      ],
      { pending: ["I smell gas in my basement"] },
    );
    expect(executed[0]?.action).toEqual({
      type: "escalate_emergency",
      emergencyClass: "gas_leak",
      summary: "Smells gas in the basement.",
    });
    expect(lastText(requests[0]?.messages.at(-1))).toContain(
      'Possible emergency: the newest messages contain wording that matches "gas_leak"',
    );
    expect(lastText(requests[1]?.messages.at(-1))).toContain(GAS_INSTRUCTIONS);
    expect(result.replies).toEqual([
      {
        kind: "text",
        text: `${GAS_INSTRUCTIONS}\n\nOh no! I've alerted the team What's your address?`,
      },
    ]);
    expect(result.diagnostics?.guardViolations).toEqual(
      expect.arrayContaining(["safety_instructions_added", "emoji_removed"]),
    );
  });

  it("rejects a class that is not configured and lists the real ones", async () => {
    const { executed, requests } = await run([
      scriptedResponse([escalate("alien_invasion")]),
      scriptedResponse([text("Are you safe right now?")]),
    ]);
    expect(executed).toHaveLength(0);
    expect(lastText(requests[1]?.messages.at(-1))).toContain(
      "The classes are: gas_leak, carbon_monoxide",
    );
  });

  it("alerts nobody when alerts are off, but still requires the safety instructions", async () => {
    const { executed, result, requests } = await run(
      [scriptedResponse([escalate("gas_leak")]), scriptedResponse([text("Please stay safe.")])],
      { settings: { "emergency.enabled": false } },
    );
    expect(executed).toHaveLength(0);
    expect(result.actions).toMatchObject([
      { action: { type: "escalate_emergency" }, outcome: { status: "rejected" } },
    ]);
    expect(lastText(requests[1]?.messages.at(-1))).toContain(
      "Nobody at the business has been alerted",
    );
    expect(result.replies[0]?.text.startsWith(GAS_INSTRUCTIONS)).toBe(true);
  });

  it("sends the safety instructions from code when the model fails after the escalation", async () => {
    const failure = new ExternalServiceError("The Claude API answered 529.", {
      provider: "anthropic",
      status: 529,
    });
    for (const second of [failure, scriptedRefusal(), scriptedResponse([text("<no_reply/>")])]) {
      const { result } = await run([scriptedResponse([escalate("gas_leak")]), second]);
      expect(result.outcome).toBe("replied");
      expect(result.replies[0]?.text).toBe(
        `${GAS_INSTRUCTIONS}\n\nI've alerted the team at Summit Roofing Co. Please send me your phone number and the address so they can reach you.`,
      );
      expect(result.diagnostics?.deterministicReply).toBe(true);
    }
  });
});

describe("stop reasons and errors", () => {
  it("returns 'refused' for a refusal, so the pipeline hands the conversation to a person", async () => {
    const { result } = await run([scriptedRefusal("cyber")]);
    expect(result).toMatchObject({ outcome: "refused", replies: [] });
    expect(result.diagnostics?.notes).toContain("refusal:cyber");
  });

  it("retries once with more room when the output limit was hit, and never sends a cut reply", async () => {
    const cut = () => scriptedResponse([text("Sorry about the le")], { stopReason: "max_tokens" });
    const ok = await run([cut(), scriptedResponse([text("Sorry about the leak!")])]);
    expect(ok.requests.map((request) => request.maxTokens)).toEqual([16_000, 32_000]);
    expect(ok.result.replies[0]?.text).toBe("Sorry about the leak!");
    const failed = await run([cut(), cut()]);
    expect(failed.result).toMatchObject({ outcome: "failed", replies: [] });
  });

  it("throws a retryable API error so the job retries the step", async () => {
    const overloaded = new ExternalServiceError("The Claude API answered 529.", {
      provider: "anthropic",
      status: 529,
    });
    await expect(run([overloaded])).rejects.toBe(overloaded);
  });

  it("returns 'failed' for an error that no retry can fix", async () => {
    const bad = new ExternalServiceError("The Claude API answered 400.", {
      provider: "anthropic",
      status: 400,
    });
    expect((await run([bad])).result).toMatchObject({ outcome: "failed", replies: [] });
    const unconfigured = new ConfigError("The Claude API is not configured.");
    const { result } = await run([unconfigured]);
    expect(result.outcome).toBe("failed");
    expect(result.diagnostics?.notes).toContain("error:config_missing");
  });

  it("gives every call a timeout and a deadline that fit in the turn's budget", async () => {
    let now = Date.parse("2026-11-10T17:00:00.000Z");
    const clock = () => new Date(now);
    const { requests } = await run(
      [
        (request) => {
          now += 100_000;
          void request;
          return scriptedResponse([toolUse("request_photo", { subject: "the roof" })]);
        },
        scriptedResponse([text("Could you send a photo?")]),
      ],
      { engine: { clock, turnBudgetMs: 150_000, callTimeoutMs: 90_000 } },
    );
    expect(requests[0]?.timeoutMs).toBe(90_000);
    // 50 seconds of the budget are left for the second call.
    expect(requests[1]?.timeoutMs).toBe(50_000);
    expect(requests[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("stops with a retryable error when the budget is used up", async () => {
    let now = Date.parse("2026-11-10T17:00:00.000Z");
    const attempt = run(
      [
        () => {
          now += 149_000;
          return scriptedResponse([toolUse("request_photo", { subject: "the roof" })]);
        },
        scriptedResponse([text("never reached")]),
      ],
      { engine: { clock: () => new Date(now), turnBudgetMs: 150_000 } },
    );
    await expect(attempt).rejects.toMatchObject({
      retryable: true,
      details: { reason: "turn_deadline" },
    });
  });

  it("refuses a settings snapshot that is not a resolved snapshot of the registry", async () => {
    const { business } = testBusiness();
    const engine = createEngine({ model: createScriptedModelClient([]) });
    const broken = {
      ...testInput({ business }),
      settings: { values: {}, sources: {}, version: "x" },
    };
    await expect(
      engine.respond(broken as EngineTurnInput, {
        knowledge: { coreFacts: async () => [], retrieve: async () => [] },
        tools: { execute: async () => applied },
        modelCalls: { record: async () => {} },
        logger: createLogger({ level: "error", sink: () => {} }),
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("the output guard in the loop", () => {
  it("asks for one rewrite, with the problem and without tools, and sends the fixed reply", async () => {
    const { result, requests } = await run([
      scriptedResponse([text("A repair like that usually runs about $450. What's the ZIP code?")]),
      scriptedResponse([text("The team quotes after a look at the roof. What's the ZIP code?")]),
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.toolChoice).toBe("none");
    const note = lastText(requests[1]?.messages.at(-1));
    expect(note).toContain("The draft states a dollar figure ($450)");
    expect(note).toContain("<rejected_draft>");
    // The rejected draft is not replayed as an assistant turn.
    expect(requests[1]?.messages.map((message) => message.role)).toEqual(
      requests[0]?.messages.map((message) => message.role),
    );
    expect(result.replies).toEqual([
      { kind: "text", text: "The team quotes after a look at the roof. What's the ZIP code?" },
    ]);
    expect(result.diagnostics).toMatchObject({
      rewrites: 1,
      guardViolations: ["price_not_allowed"],
    });
  });

  it("repairs in code what the rewrite did not fix", async () => {
    const { result, requests } = await run([
      scriptedResponse([text("It's about $450. What's the ZIP code?")]),
      scriptedResponse([text("Honestly, around $450. What's the ZIP code?")]),
    ]);
    expect(requests).toHaveLength(2);
    expect(result.replies).toEqual([{ kind: "text", text: "What's the ZIP code?" }]);
  });

  it("hands off and sends a safe message when nothing sendable is left", async () => {
    const leak = scriptedResponse([text("My reference is PROMPT-REF-7Q4X-HSRB-2VNK.")]);
    const { result, executed } = await run([leak, leak]);
    expect(result.replies[0]?.text).toContain("I've passed it to the team at Summit Roofing Co.");
    expect(executed.map((entry) => entry.action.type)).toEqual(["handoff_to_human"]);
    expect(result.diagnostics?.guardViolations).toEqual(
      expect.arrayContaining(["prompt_leak", "replaced_with_fallback"]),
    );
  });

  it("adds the AI disclosure to the first reply of a conversation", async () => {
    const { result } = await run(
      [scriptedResponse([text("Sorry about the leak! Is water coming in now?")])],
      {
        history: [],
      },
    );
    expect(result.replies[0]?.text).toBe(
      "I'm Alex, the virtual assistant for Summit Roofing Co. Sorry about the leak! Is water coming in now?",
    );
  });
});

describe("outside office hours", () => {
  // Tuesday, 20:30 in Denver: closed since 17:00, and Wednesday is Veterans Day.
  const NIGHT = "2026-11-11T03:30:00.000Z";

  it("tells the model the office is closed and when it opens, in the default mode", async () => {
    const { requests, result } = await run(
      [scriptedResponse([text("Thanks! The team is back Thursday at 8.")])],
      {
        now: NIGHT,
      },
    );
    expect(lastText(requests[0]?.messages.at(-1))).toContain(
      "Office: closed now; opens on Thursday at 8:00 AM.",
    );
    expect(result.outcome).toBe("replied");
  });

  it("sends only the after-hours message in auto-reply mode, once per closed period", async () => {
    const settings = { "hours.after_hours_mode": "auto_reply" } as const;
    const first = await run(
      [
        scriptedResponse([
          toolUse("update_lead_fields", {
            fields: [{ key: "service_type", value: "roof leak", confidence: 1, evidence: null }],
          }),
        ]),
        scriptedResponse([text("Happy to help right now! What's your ZIP?")]),
      ],
      { now: NIGHT, settings, history: [] },
    );
    expect(lastText(first.requests[0]?.messages.at(-1))).toContain(
      "write only <after_hours_message/>",
    );
    // Whatever the model wrote, the configured message goes out.
    expect(first.result.replies).toEqual([
      {
        kind: "text",
        text: "Thanks for reaching out to Summit Roofing Co.! The office is closed right now. I can take down the details so the team can pick this up first thing when we open.",
      },
    ]);
    expect(first.result.diagnostics).toMatchObject({
      deterministicReply: true,
      notes: ["after_hours:send_message"],
    });
    // The lead fields are saved, and the conversation is picked up when the office opens:
    // Thursday 08:00 in Denver is 35.5 hours after Tuesday 20:30.
    expect(first.executed.map((entry) => entry.action)).toEqual([
      expect.objectContaining({ type: "update_lead_fields" }),
      expect.objectContaining({ type: "schedule_follow_up", after: "PT2130M" }),
    ]);

    const second = await run([scriptedResponse([text("<no_reply/>")])], {
      now: "2026-11-11T04:00:00.000Z",
      settings,
      history: [
        testTurn("customer", "My roof leaks", NIGHT),
        testTurn("bot", "Thanks for reaching out...", "2026-11-11T03:30:10.000Z"),
      ],
    });
    expect(lastText(second.requests[0]?.messages.at(-1))).toContain("write only <no_reply/>");
    expect(second.result).toMatchObject({ outcome: "no_reply", replies: [] });
  });

  it("stays silent in silent mode", async () => {
    const { result, executed } = await run([scriptedResponse([text("Hello! How can I help?")])], {
      now: NIGHT,
      settings: { "hours.after_hours_mode": "silent" },
    });
    expect(result).toMatchObject({ outcome: "no_reply", replies: [] });
    expect(executed.map((entry) => entry.action.type)).toEqual(["schedule_follow_up"]);
  });

  it("still handles an emergency at night, whatever the mode", async () => {
    const { result } = await run(
      [
        scriptedResponse([
          toolUse("escalate_emergency", {
            emergency_class: "gas_leak",
            summary: "Gas smell in the kitchen.",
          }),
        ]),
        scriptedResponse([
          text(`${GAS_INSTRUCTIONS}\n\nI've alerted the team. What's the best number for you?`),
        ]),
      ],
      { now: NIGHT, settings: { "hours.after_hours_mode": "silent" }, pending: ["I smell gas!!"] },
    );
    expect(result.outcome).toBe("replied");
    expect(result.replies[0]?.text.startsWith(GAS_INSTRUCTIONS)).toBe(true);
    expect(result.diagnostics?.deterministicReply).toBe(false);
  });

  it("refuses to book while the office is closed when the business says so", async () => {
    const { executed, requests } = await run(
      [
        scriptedResponse([toolUse("offer_times", { preference: "mornings", count: 3 })]),
        scriptedResponse([text("The team will be in touch on Thursday.")]),
      ],
      { now: NIGHT, settings: { "routing.after_hours_booking": "contact_later" } },
    );
    expect(executed).toHaveLength(0);
    expect(lastText(requests[1]?.messages.at(-1))).toContain(
      "does not book meetings while it is closed",
    );
  });
});

describe("a customer who opted out (C13)", () => {
  const restriction = { kind: "emergency_only", reason: "opted_out" } as const;

  it("sends nothing but tells the model why, unless it is an emergency", async () => {
    const { result, requests } = await run(
      [scriptedResponse([text("Happy to help! What size is the roof?")])],
      { restriction, pending: ["How much is a new roof?"] },
    );
    expect(lastText(requests[0]?.messages.at(-1))).toContain(
      "Opt-out rule for this turn: the customer opted out of automated messages from the business. Unless the newest messages describe an emergency, write only <no_reply/>",
    );
    expect(requests[0]?.hints).toMatchObject({ reply: { emergencyOnly: true } });
    expect(result).toMatchObject({
      outcome: "no_reply",
      replies: [],
      diagnostics: { notes: ["emergency_only:opted_out"] },
    });
  });

  it("answers an emergency in full: escalation and safety instructions first", async () => {
    const { result, executed } = await run(
      [
        scriptedResponse([
          toolUse("escalate_emergency", {
            emergency_class: "gas_leak",
            summary: "Gas smell in the kitchen.",
          }),
        ]),
        scriptedResponse([text("I've alerted the team. What's the address?")]),
      ],
      { restriction, pending: ["I smell gas in the kitchen"] },
    );
    expect(executed.map((entry) => entry.action.type)).toEqual(["escalate_emergency"]);
    expect(result.outcome).toBe("replied");
    expect(result.replies[0]?.text.startsWith(GAS_INSTRUCTIONS)).toBe(true);
  });

  it("does not turn a refusal into a takeover, and ignores the after-hours rules", async () => {
    const refused = await run([scriptedRefusal()], { restriction });
    expect(refused.result.outcome).toBe("no_reply");
    const night = await run([scriptedResponse([text("Hello!")])], {
      restriction,
      now: "2026-11-11T08:00:00.000Z",
      settings: { "hours.after_hours_mode": "auto_reply" },
    });
    expect(night.result).toMatchObject({ outcome: "no_reply", replies: [] });
    expect(night.executed).toEqual([]);
    expect(lastText(night.requests[0]?.messages.at(-1))).not.toContain("After-hours rule");
  });

  it("leaves a turn without a restriction as it was", async () => {
    const { result, requests } = await run([scriptedResponse([text("Sure, what size?")])], {
      restriction: null,
    });
    expect(result.outcome).toBe("replied");
    expect(lastText(requests[0]?.messages.at(-1))).not.toContain("Opt-out rule");
  });
});

describe("turns without a new message", () => {
  const history = [
    testTurn("customer", "My roof leaks over the kitchen.", "2026-11-10T15:00:00.000Z"),
    testTurn("bot", "Sorry about that! What's the ZIP code?", "2026-11-10T15:00:20.000Z"),
  ];

  it("writes a nudge with the follow-up model settings and says which nudge it is", async () => {
    const { requests, result } = await run(
      [scriptedResponse([text("Still dealing with that leak? What's the ZIP code?")])],
      {
        trigger: "follow_up",
        pending: [],
        history,
        settings: { "model.follow_up.effort": "low", "follow_up.max_nudges.widget": 2 },
      },
    );
    expect(requests[0]).toMatchObject({ purpose: "follow_up", effort: "low" });
    expect(lastText(requests[0]?.messages.at(-1))).toContain(
      "This turn: a follow-up. The customer has not written since your last message. Follow the follow-up rules. This is follow-up 1 of at most 2 on this channel.",
    );
    // The user turn says there is nothing new, so the system message has something to follow.
    expect(lastText(requests[0]?.messages.at(-2))).toContain("There is no new customer message.");
    expect(result.outcome).toBe("replied");
  });

  it("says when a nudge is the last one", async () => {
    const nudged = [...history, testTurn("bot", "Still there?", "2026-11-10T17:05:00.000Z")];
    const { requests } = await run([scriptedResponse([text("Last check-in from me.")])], {
      trigger: "follow_up",
      pending: [],
      history: nudged,
      now: "2026-11-11T17:00:00.000Z",
      settings: { "follow_up.max_nudges.widget": 2, "hours.us_federal_holidays": false },
    });
    expect(lastText(requests[0]?.messages.at(-1))).toContain(
      "This is follow-up 2 of at most 2 on this channel, so it is the last one.",
    );
  });

  it("answers unanswered messages when a follow-up finds them, instead of nudging", async () => {
    const unanswered = [
      testTurn("customer", "Do you do metal roofs?", "2026-11-11T03:30:00.000Z"),
      testTurn(
        "bot",
        "Thanks for reaching out to Summit Roofing Co.! The office is closed right now. I can take down the details so the team can pick this up first thing when we open.",
        "2026-11-11T03:30:10.000Z",
      ),
    ];
    const { requests } = await run(
      [scriptedResponse([text("Good morning! Yes, we install metal roofs.")])],
      {
        trigger: "follow_up",
        pending: [],
        history: unanswered,
        now: "2026-11-12T15:00:00.000Z",
      },
    );
    expect(requests[0]?.purpose).toBe("reply");
    expect(lastText(requests[0]?.messages.at(-1))).toContain("were never answered");
  });

  it("waits for the customer after a takeover is released, unless a check-in is configured", async () => {
    const afterPerson = [
      ...history,
      testTurn("human_agent", "This is Dana, I'll look into it.", "2026-11-10T16:00:00.000Z"),
      testTurn("customer", "Any news?", "2026-11-10T16:30:00.000Z"),
    ];
    const waiting = await run([], {
      trigger: "takeover_released",
      pending: [],
      history: afterPerson,
    });
    expect(waiting.result.outcome).toBe("no_reply");
    expect(waiting.requests).toHaveLength(0);

    const checkIn = await run(
      [scriptedResponse([text("Thanks for your patience! Dana is on it.")])],
      {
        trigger: "takeover_released",
        pending: [],
        history: afterPerson,
        settings: { "handoff.on_release": "check_in" },
      },
    );
    expect(checkIn.result.outcome).toBe("replied");
    expect(lastText(checkIn.requests[0]?.messages.at(-1))).toContain("has given it back to you");
  });
});

describe("knowledge", () => {
  const fact = (
    id: string,
    category: KnowledgeFact["category"],
    content: string,
  ): KnowledgeFact => ({
    id,
    category,
    title: "",
    content,
    source: "manual",
    updatedAt: "2026-10-01T00:00:00.000Z",
  });

  it("keeps core facts in the cached section and puts looked-up facts into the turn context", async () => {
    const queries: string[] = [];
    const { requests } = await run([scriptedResponse([text("Yes, 10 years on workmanship.")])], {
      pending: ["What warranty do you give on a new roof?"],
      facts: [
        fact("a", "services", "Roof repair and replacement."),
        fact("b", "pricing", "Inspection $149."),
      ],
      retrieve: async (query) => {
        queries.push(query.text);
        expect(query.limit).toBe(8);
        return [
          fact("a", "services", "Roof repair and replacement."),
          fact("c", "faq", "Metal roofs last 50 years."),
        ];
      },
    });
    expect(queries).toEqual(["What warranty do you give on a new roof?"]);
    const business = requests[0]?.system[2]?.text ?? "";
    expect(business).toContain("Roof repair and replacement.");
    // "pricing" is not among the categories kept in every reply.
    expect(business).not.toContain("Inspection $149.");
    const context = lastText(requests[0]?.messages.at(-1));
    expect(context).toContain("- [faq] Metal roofs last 50 years.");
    // A fact that is already in the business section is not repeated.
    expect(context).not.toContain("Roof repair and replacement.");
  });

  it("answers without looked-up facts when the look-up fails", async () => {
    const { result } = await run([scriptedResponse([text("The team will confirm that.")])], {
      retrieve: async () => {
        throw new Error("search index down");
      },
    });
    expect(result.outcome).toBe("replied");
    expect(result.diagnostics?.notes).toContain("retrieval_failed");
  });
});
