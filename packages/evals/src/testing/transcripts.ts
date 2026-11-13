import type {
  ActionOutcome,
  EngineAction,
  EngineTurnDiagnostics,
  ExecutedAction,
  LeadFieldValue,
  LeadSnapshot,
  RoutingOutcome,
  TurnTrigger,
} from "@repo/core";

import { allScenarios } from "../scenarios/matrix";
import type { PersonaId, ProfileId, Scenario } from "../scenarios/types";
import {
  type BotEntry,
  type CustomerEntry,
  type CustomerSource,
  type EndReason,
  NO_USAGE,
  type Transcript,
  type TranscriptEntry,
} from "../simulate/transcript";
import { fill } from "../grade/rules";

/**
 * Hand-made conversations: a transcript is built entry by entry, so that exactly one thing
 * can be put wrong into an otherwise clean conversation. Used by the tests of the graders
 * and by the judge's calibration probes (`src/calibration`).
 */

/** The first scenario of the matrix with these properties. Throws when there is none. */
export function scenarioWith(wanted: {
  readonly persona?: PersonaId;
  readonly profile?: ProfileId;
  readonly channel?: Scenario["channel"];
  readonly notChannel?: Scenario["channel"];
  readonly suite?: Scenario["suite"];
}): Scenario {
  const found = allScenarios().find(
    (scenario) =>
      (wanted.persona === undefined || scenario.persona.id === wanted.persona) &&
      (wanted.profile === undefined || scenario.profile.id === wanted.profile) &&
      (wanted.channel === undefined || scenario.channel === wanted.channel) &&
      (wanted.notChannel === undefined || scenario.channel !== wanted.notChannel) &&
      (wanted.suite === undefined || scenario.suite === wanted.suite),
  );
  if (found === undefined) throw new Error(`No scenario with ${JSON.stringify(wanted)}.`);
  return found;
}

export function did(
  action: EngineAction,
  status: ActionOutcome["status"] = "applied",
  outcome: Partial<ActionOutcome> = {},
): ExecutedAction {
  return {
    toolCallId: `toolu_test_${action.type}`,
    action,
    outcome: { status, message: null, data: null, ...outcome },
  };
}

export function customerSays(
  turn: number,
  texts: readonly string[],
  source: CustomerSource = turn === 1 ? "opening" : "simulated",
): CustomerEntry {
  return {
    kind: "customer",
    turn,
    at: new Date(Date.UTC(2026, 10, 3, 17, 15 + turn * 2)).toISOString(),
    source,
    messages: texts.map((text) => ({ text })),
  };
}

export interface BotOptions {
  readonly actions?: readonly ExecutedAction[];
  readonly first?: boolean;
  readonly trigger?: TurnTrigger;
  readonly outcome?: BotEntry["outcome"];
  readonly routing?: RoutingOutcome | null;
  readonly leadStatus?: string;
  readonly diagnostics?: Partial<EngineTurnDiagnostics>;
}

export function botSays(
  turn: number,
  replies: readonly string[],
  options: BotOptions = {},
): BotEntry {
  return {
    kind: "bot",
    turn,
    at: new Date(Date.UTC(2026, 10, 3, 17, 15 + turn * 2, 5)).toISOString(),
    trigger: options.trigger ?? "inbound_message",
    outcome: options.outcome ?? (replies.length > 0 ? "replied" : "no_reply"),
    replies: replies.map((text) => ({ text })),
    actions: options.actions ?? [],
    diagnostics: {
      modelCalls: 1,
      toolRounds: 0,
      guardViolations: [],
      rewrites: 0,
      deterministicReply: false,
      notes: [],
      ...options.diagnostics,
    },
    routing: options.routing ?? null,
    leadStatus: options.leadStatus ?? "qualifying",
    first: options.first ?? turn === 1,
    usage: NO_USAGE,
    latencyMs: 1200,
    calls: [],
  };
}

function field(key: string, value: LeadFieldValue["value"]): LeadFieldValue {
  return { key, value, confidence: 1, evidence: null, updatedAt: "2026-11-03T17:20:00.000Z" };
}

export function leadWith(
  fields: Readonly<Record<string, LeadFieldValue["value"]>>,
  routing: RoutingOutcome | null = null,
): LeadSnapshot {
  return {
    id: null,
    status:
      routing === null ? "qualifying" : routing === "disqualify" ? "disqualified" : "qualified",
    fields: Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, field(key, value)]),
    ),
    routing:
      routing === null
        ? null
        : {
            outcome: routing,
            score: 80,
            band: "hot",
            reasons: [],
            decidedAt: "2026-11-03T17:20:00.000Z",
            settingsVersion: "test",
          },
  };
}

export function transcriptOf(
  scenario: Scenario,
  entries: readonly TranscriptEntry[],
  overrides: Partial<Transcript> = {},
): Transcript {
  return {
    scenarioId: scenario.id,
    entries,
    ended: "customer_left" satisfies EndReason,
    leaveReason: "satisfied",
    lead: leadWith({}),
    handedOff: false,
    photosSent: 0,
    promptVersion: "reply-v1.r2",
    usage: { engine: NO_USAGE, customer: NO_USAGE },
    costMicroUsd: { engine: null, customer: null },
    engineModels: ["claude-fable-5-2"],
    customerModels: ["claude-opus-5-5"],
    retries: 0,
    ...overrides,
  };
}

/**
 * What a correct first message starts with in this scenario: the opening line (where one is
 * set for the channel) and the AI disclosure (where it is said upfront).
 */
export function properOpening(scenario: Scenario): string {
  const values = scenario.settings.values;
  const key = `voice.opening_message.${scenario.channel}` as const;
  const opening = scenario.channel === "widget" ? "" : fill(scenario, values[key]);
  const disclosure =
    values["persona.ai_disclosure"] === "upfront"
      ? fill(scenario, values["persona.ai_disclosure_wording"])
      : "";
  return [opening, disclosure].filter((part) => part.trim().length > 0).join(" ");
}
