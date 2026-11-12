import { zonedInstant } from "@repo/ai";

import { EVAL_BUSINESSES, EVAL_SEGMENTS, type EvalSegment } from "../fixtures/businesses";
import { expectedRouting } from "./oracle";
import { PERSONAS } from "./personas";
import { scenarioSettings, SETTINGS_PROFILES } from "./profiles";
import {
  EVAL_CHANNELS,
  type EvalChannel,
  PERSONA_IDS,
  type PersonaId,
  PROFILE_IDS,
  type Scenario,
} from "./types";

/**
 * The scenario matrix: every persona at every business, 12 × 6 = 72 conversations in six
 * suites (one per segment). The settings profile and the channel of a scenario come from a
 * fixed rotation, so that across the matrix every persona meets every profile and every
 * channel it would plausibly use, and a run today plays the same scenarios as the run a
 * baseline was saved from.
 */

/** The day every conversation starts: a Tuesday without a holiday before or after it. */
export const EVAL_DATE = "2026-11-03";
const DEFAULT_START = "10:15";

function channelFor(personaIndex: number, segmentIndex: number, allowed?: readonly EvalChannel[]) {
  for (let step = 0; step < EVAL_CHANNELS.length; step += 1) {
    const channel = EVAL_CHANNELS[(personaIndex * 2 + segmentIndex + step) % EVAL_CHANNELS.length];
    if (channel !== undefined && (allowed === undefined || allowed.includes(channel))) {
      return channel;
    }
  }
  return "whatsapp" as const;
}

function build(personaId: PersonaId, segment: EvalSegment): Scenario {
  const personaIndex = PERSONA_IDS.indexOf(personaId);
  const segmentIndex = EVAL_SEGMENTS.indexOf(segment);
  const persona = PERSONAS[personaId];
  const business = EVAL_BUSINESSES[segment];
  const profileId = PROFILE_IDS[(personaIndex + segmentIndex) % PROFILE_IDS.length] ?? "default";
  const profile = SETTINGS_PROFILES[profileId];
  const instance = persona.build(business);
  const settings = scenarioSettings(business, profile);
  const startAt = zonedInstant(
    EVAL_DATE,
    instance.startsAt ?? DEFAULT_START,
    business.timezone,
  ).toISOString();
  const { routing: _routing, ...expect } = instance.expect;
  const expected = expectedRouting(settings, instance, expect.spam, startAt);
  return {
    id: `${segment}.${personaId}`,
    suite: segment,
    persona,
    instance,
    business,
    profile,
    channel: channelFor(personaIndex, segmentIndex, persona.channels),
    settings,
    startAt,
    expect: {
      ...expect,
      ...(instance.expect.routing === "any" ? {} : { routing: expected }),
    },
    // Two segments per persona, four personas per segment.
    core: segmentIndex === personaIndex % 6 || segmentIndex === (personaIndex + 3) % 6,
  };
}

let cached: readonly Scenario[] | null = null;

/** All 72 scenarios, suite by suite. Built once: the fixtures never change at run time. */
export function allScenarios(): readonly Scenario[] {
  cached ??= EVAL_SEGMENTS.flatMap((segment) =>
    PERSONA_IDS.map((personaId) => build(personaId, segment)),
  );
  return cached;
}

export interface ScenarioFilter {
  readonly suites?: readonly string[];
  readonly personas?: readonly string[];
  readonly scenarios?: readonly string[];
  readonly profiles?: readonly string[];
  readonly core?: boolean;
  readonly limit?: number;
}

/** The scenarios a run plays. Unknown names are an error: a typo must not pass as "0 failed". */
export function selectScenarios(filter: ScenarioFilter = {}): Scenario[] {
  const all = allScenarios();
  const check = (wanted: readonly string[] | undefined, known: readonly string[], what: string) => {
    const unknown = (wanted ?? []).filter((name) => !known.includes(name));
    if (unknown.length > 0) {
      throw new Error(`Unknown ${what}: ${unknown.join(", ")}. Known: ${known.join(", ")}.`);
    }
  };
  check(filter.suites, EVAL_SEGMENTS, "suite");
  check(filter.personas, PERSONA_IDS, "persona");
  check(filter.profiles, PROFILE_IDS, "profile");
  check(
    filter.scenarios,
    all.map((scenario) => scenario.id),
    "scenario",
  );
  const has = (wanted: readonly string[] | undefined, value: string) =>
    wanted === undefined || wanted.length === 0 || wanted.includes(value);
  const selected = all.filter(
    (scenario) =>
      has(filter.suites, scenario.suite) &&
      has(filter.personas, scenario.persona.id) &&
      has(filter.profiles, scenario.profile.id) &&
      has(filter.scenarios, scenario.id) &&
      (filter.core !== true || scenario.core),
  );
  return filter.limit === undefined ? selected : selected.slice(0, Math.max(0, filter.limit));
}
