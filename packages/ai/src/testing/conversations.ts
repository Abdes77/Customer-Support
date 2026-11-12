import {
  CHANNEL_CAPABILITIES,
  type ChannelId,
  type CustomerProfile,
  type EngineActionType,
  type LeadStatus,
  type RoutingOutcome,
} from "@repo/core";
import { type AppSettings, channelSetting, settingsWith } from "@repo/settings";

import {
  createDryRunConversation,
  type CustomerMessage,
  type DryRunConversation,
  type DryRunState,
  type DryRunTurn,
} from "../dry-run/dry-run";
import { createEngine } from "../engine/engine";
import { createScriptedModelClient } from "../model/scripted";
import type { ModelClient, ModelResponse, ModelTool } from "../model/types";
import { CURRENT_REPLY_PROMPT } from "../prompt/core";
import { modelTools } from "../tools/definitions";
import { testBusiness, type TestSegment } from "./fixtures";

/**
 * Scripted conversations: a customer's lines, the settings of the business, and what the
 * conversation must come to. One script runs two ways.
 *
 * - Mocked (`pnpm verify`): the model's responses are part of the script, written by hand in
 *   the Claude API's response format. This proves what the engine does with them: the
 *   prompt it builds, the tools it runs, the guard, the lead record.
 * - Live (`pnpm --filter @repo/ai live:conversations`, needs `ANTHROPIC_API_KEY`): the same
 *   customer lines go to the real model, and the same expectations are checked against what
 *   it actually does. This is the check of the prompt itself.
 */

export interface TurnExpectations {
  /** Tools that must be called in this turn. */
  readonly tools?: readonly EngineActionType[];
  /** Tools that must not be called in this turn. */
  readonly noTools?: readonly EngineActionType[];
  /** No tool at all in this turn. */
  readonly noToolCalls?: boolean;
  readonly outcome?: "replied" | "no_reply";
  /** Each must be found in the turn's replies (joined). */
  readonly replyIncludes?: readonly (string | RegExp)[];
  readonly replyExcludes?: readonly (string | RegExp)[];
  readonly replyStartsWith?: string;
}

export interface ScriptStep {
  readonly customer: string | CustomerMessage | readonly (string | CustomerMessage)[];
  /** Minutes since the previous step. Default: one. */
  readonly afterMinutes?: number;
  /** The model's responses in this turn, in order. Used by the mocked run only. */
  readonly model: readonly ModelResponse[];
  readonly expect?: TurnExpectations;
}

export interface ScriptExpectations {
  /** The lead must end in one of these states. */
  readonly leadStatus?: readonly LeadStatus[];
  /** The routing decision at the end; null means none. */
  readonly routing?: RoutingOutcome | null;
  /** Lead fields that must be recorded: an exact value, or a predicate. */
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly toolsCalled?: readonly EngineActionType[];
  readonly toolsNotCalled?: readonly EngineActionType[];
  readonly handedOff?: boolean;
  readonly ended?: DryRunState["ended"];
  /** Must not appear in any reply of the conversation. */
  readonly neverInReplies?: readonly (string | RegExp)[];
}

export interface ConversationScript {
  readonly id: string;
  readonly title: string;
  readonly segment: TestSegment;
  readonly settings?: Partial<AppSettings>;
  readonly channel?: ChannelId;
  readonly customer?: CustomerProfile;
  /** The time of the first message. Default: a Tuesday morning during office hours. */
  readonly startAt?: string;
  /** Meeting slots the calendar stand-in offers. Empty: booking is not available. */
  readonly slots?: DryRunState["slots"];
  readonly steps: readonly ScriptStep[];
  readonly expect: ScriptExpectations;
}

export interface ScriptRun {
  readonly script: ConversationScript;
  readonly conversation: DryRunConversation;
  readonly turns: readonly DryRunTurn[];
  /** Everything that did not hold. Empty: the conversation behaved as specified. */
  readonly failures: readonly string[];
}

function matches(text: string, wanted: string | RegExp): boolean {
  return typeof wanted === "string"
    ? text.toLowerCase().includes(wanted.toLowerCase())
    : wanted.test(text);
}

const show = (wanted: string | RegExp) =>
  typeof wanted === "string" ? `"${wanted}"` : String(wanted);

/** Checks that apply to every reply of every script, whatever the model. */
function universalFailures(script: ConversationScript, turn: DryRunTurn, index: number): string[] {
  const failures: string[] = [];
  const values = turn.input.settings.values as AppSettings;
  const channel = script.channel ?? "test";
  const where = `turn ${index + 1}`;
  const email = CHANNEL_CAPABILITIES[channel].format === "email";
  const limit = Math.min(
    channelSetting(values, "voice.max_reply_characters", channel),
    CHANNEL_CAPABILITIES[channel].maxTextLength,
  );
  // Mandatory passages (safety instructions, disclosure) may take a reply over the limit.
  const allowance = values["emergency.classes"].reduce(
    (longest, item) => Math.max(longest, item.safety_instructions.length),
    0,
  );
  if (turn.replies.length > (email ? 1 : values["voice.max_messages_per_turn"])) {
    failures.push(`${where}: ${turn.replies.length} messages in one reply`);
  }
  for (const reply of turn.replies) {
    if (reply.length > limit + allowance + 200)
      failures.push(`${where}: a reply of ${reply.length} characters`);
    if (reply.includes(CURRENT_REPLY_PROMPT.canary))
      failures.push(`${where}: the reply quotes the prompt`);
    if (/<\/?[a-z_]+[^>]*>/i.test(reply)) failures.push(`${where}: internal markup in a reply`);
    if (/\*\*|^#{1,6}\s/m.test(reply)) failures.push(`${where}: markdown in a reply`);
    const questions = (reply.match(/\?/g) ?? []).length;
    if (!email && questions > values["qualification.questions_per_message"]) {
      failures.push(`${where}: ${questions} questions in one message`);
    }
  }
  return failures;
}

function turnFailures(turn: DryRunTurn, expect: TurnExpectations, index: number): string[] {
  const failures: string[] = [];
  const where = `turn ${index + 1}`;
  const called = turn.result.actions.map((entry) => entry.action.type);
  const reply = turn.replies.join("\n");
  for (const tool of expect.tools ?? []) {
    if (!called.includes(tool)) failures.push(`${where}: ${tool} was not called`);
  }
  for (const tool of expect.noTools ?? []) {
    if (called.includes(tool)) failures.push(`${where}: ${tool} was called`);
  }
  if (expect.noToolCalls === true && called.length > 0) {
    failures.push(`${where}: tools were called (${called.join(", ")})`);
  }
  if (expect.outcome !== undefined && turn.result.outcome !== expect.outcome) {
    failures.push(`${where}: outcome ${turn.result.outcome}, expected ${expect.outcome}`);
  }
  for (const wanted of expect.replyIncludes ?? []) {
    if (!matches(reply, wanted)) failures.push(`${where}: the reply lacks ${show(wanted)}`);
  }
  for (const unwanted of expect.replyExcludes ?? []) {
    if (matches(reply, unwanted)) failures.push(`${where}: the reply contains ${show(unwanted)}`);
  }
  if (expect.replyStartsWith !== undefined && !reply.startsWith(expect.replyStartsWith)) {
    failures.push(
      `${where}: the reply does not start with "${expect.replyStartsWith.slice(0, 40)}..."`,
    );
  }
  return failures;
}

function conversationFailures(
  script: ConversationScript,
  conversation: DryRunConversation,
): string[] {
  const failures: string[] = [];
  const { expect } = script;
  const { state } = conversation;
  const called = new Set(state.actions.map((entry) => entry.action.type));
  if (expect.leadStatus !== undefined && !expect.leadStatus.includes(state.lead.status)) {
    failures.push(`lead status ${state.lead.status}, expected ${expect.leadStatus.join(" or ")}`);
  }
  if (expect.routing !== undefined && (state.lead.routing?.outcome ?? null) !== expect.routing) {
    failures.push(
      `routing ${state.lead.routing?.outcome ?? "none"}, expected ${expect.routing ?? "none"}`,
    );
  }
  for (const [key, wanted] of Object.entries(expect.fields ?? {})) {
    const field = state.lead.fields[key];
    if (field === undefined) {
      failures.push(`lead field ${key} was not recorded`);
    } else if (typeof wanted === "function") {
      if ((wanted as (value: unknown) => boolean)(field.value) !== true) {
        failures.push(`lead field ${key} has an unexpected value`);
      }
    } else if (field.value !== wanted) {
      failures.push(
        `lead field ${key} is ${JSON.stringify(field.value)}, expected ${JSON.stringify(wanted)}`,
      );
    }
  }
  for (const tool of expect.toolsCalled ?? []) {
    if (!called.has(tool)) failures.push(`${tool} was never called`);
  }
  for (const tool of expect.toolsNotCalled ?? []) {
    if (called.has(tool)) failures.push(`${tool} was called`);
  }
  if (expect.handedOff !== undefined && state.handedOff !== expect.handedOff) {
    failures.push(`handed off: ${state.handedOff}, expected ${expect.handedOff}`);
  }
  if (expect.ended !== undefined && state.ended !== expect.ended) {
    failures.push(`ended: ${state.ended ?? "no"}, expected ${expect.ended ?? "no"}`);
  }
  const replies = conversation.turns.flatMap((turn) => turn.replies).join("\n");
  for (const unwanted of expect.neverInReplies ?? []) {
    if (matches(replies, unwanted)) failures.push(`a reply contains ${show(unwanted)}`);
  }
  return failures;
}

/** The scripted responses of all steps, in the order the engine will ask for them. */
export function scriptedModelFor(script: ConversationScript) {
  return createScriptedModelClient(script.steps.flatMap((step) => [...step.model]));
}

export interface RunScriptOptions {
  /** Default: the script's own responses, played back. Pass the real client for a live run. */
  readonly model?: ModelClient;
  readonly strictTools?: boolean;
}

/** Plays a script against the engine and collects what did not hold. */
export async function runScript(
  script: ConversationScript,
  options: RunScriptOptions = {},
): Promise<ScriptRun> {
  const { business, facts } = testBusiness(script.segment);
  const scripted = options.model === undefined ? scriptedModelFor(script) : null;
  const engine = createEngine({
    model: options.model ?? scripted ?? scriptedModelFor(script),
    ...(options.strictTools === undefined ? {} : { strictTools: options.strictTools }),
  });
  const conversation = createDryRunConversation({
    engine,
    business,
    settings: settingsWith(script.settings ?? {}),
    facts,
    ...(script.channel === undefined ? {} : { channel: script.channel }),
    ...(script.customer === undefined ? {} : { customer: script.customer }),
    ...(script.startAt === undefined ? {} : { startAt: script.startAt }),
    ...(script.slots === undefined ? {} : { slots: script.slots }),
  });

  const failures: string[] = [];
  for (const [index, step] of script.steps.entries()) {
    const before = scripted?.requests.length ?? 0;
    const turn = await conversation.customerSays(
      step.customer,
      step.afterMinutes === undefined ? {} : { afterMinutes: step.afterMinutes },
    );
    failures.push(...universalFailures(script, turn, index));
    if (step.expect !== undefined) failures.push(...turnFailures(turn, step.expect, index));
    if (scripted !== null && scripted.requests.length - before !== step.model.length) {
      failures.push(
        `turn ${index + 1}: the engine made ${scripted.requests.length - before} model calls, the script has ${step.model.length}`,
      );
    }
  }
  failures.push(...conversationFailures(script, conversation));
  return { script, conversation, turns: conversation.turns, failures };
}

/**
 * Checks a hand-written tool call against the schema the API enforces in strict mode, so a
 * mocked response cannot have a shape the real model could never produce.
 */
export function strictSchemaProblems(schema: unknown, value: unknown, path = "input"): string[] {
  if (schema === null || typeof schema !== "object") return [];
  const node = schema as Record<string, unknown>;
  if (Array.isArray(node["anyOf"])) {
    const fits = node["anyOf"].some(
      (option) => strictSchemaProblems(option, value, path).length === 0,
    );
    return fits ? [] : [`${path}: matches none of the allowed types`];
  }
  if (Array.isArray(node["enum"]) && !node["enum"].includes(value)) {
    return [`${path}: not one of ${node["enum"].join(", ")}`];
  }
  switch (node["type"]) {
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value))
        return [`${path}: not an object`];
      const properties = (node["properties"] ?? {}) as Record<string, unknown>;
      const record = value as Record<string, unknown>;
      const problems: string[] = [];
      for (const key of (node["required"] ?? []) as string[]) {
        if (!(key in record)) problems.push(`${path}.${key}: missing`);
      }
      for (const [key, item] of Object.entries(record)) {
        if (!(key in properties)) problems.push(`${path}.${key}: not in the schema`);
        else problems.push(...strictSchemaProblems(properties[key], item, `${path}.${key}`));
      }
      return problems;
    }
    case "array":
      if (!Array.isArray(value)) return [`${path}: not an array`];
      return value.flatMap((item, index) =>
        strictSchemaProblems(node["items"], item, `${path}[${index}]`),
      );
    case "string":
      return typeof value === "string" ? [] : [`${path}: not a string`];
    case "integer":
      return Number.isInteger(value) ? [] : [`${path}: not an integer`];
    case "number":
      return typeof value === "number" ? [] : [`${path}: not a number`];
    case "boolean":
      return typeof value === "boolean" ? [] : [`${path}: not a boolean`];
    case "null":
      return value === null ? [] : [`${path}: not null`];
    default:
      return [];
  }
}

/** Every tool call written into a script, checked against the tool's strict schema. */
export function scriptToolProblems(script: ConversationScript): string[] {
  const tools = new Map<string, ModelTool>(
    modelTools({ strict: true }).map((tool) => [tool.name, tool]),
  );
  const problems: string[] = [];
  script.steps.forEach((step, index) => {
    for (const response of step.model) {
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const tool = tools.get(block.name);
        if (tool === undefined) {
          problems.push(`turn ${index + 1}: no tool named ${block.name}`);
          continue;
        }
        problems.push(
          ...strictSchemaProblems(
            tool.input_schema,
            block.input,
            `turn ${index + 1} ${block.name}`,
          ),
        );
      }
    }
  });
  return problems;
}
