import {
  createAnthropicModelClient,
  createOfflineModelClient,
  type ModelClient,
  OFFLINE_MODEL_ID,
} from "@repo/ai";
import { ConfigError } from "@repo/core";
import { DEFAULT_MODEL, type EffortLevel } from "@repo/settings";

import { STAND_IN_JUDGE_MODEL } from "../grade/judge";
import type { RunMode } from "../grade/score";
import { createStandInJudgeModel } from "../grade/stand-in-judge";
import { createStandInCustomerModel, STAND_IN_CUSTOMER_MODEL } from "../simulate/stand-in-customer";

/**
 * The three model roles of an evaluation and who plays them.
 *
 * - The engine's model writes the bot's replies. It is the system under test, chosen by the
 *   `model.reply.*` settings of each scenario (claude-fable-5-2 by default).
 * - The customer model plays the simulated customers.
 * - The judge model scores the conversations. It is deliberately not the model under test:
 *   a model tends to prefer answers that read like its own.
 *
 * A live run uses the Claude API for all three. A mock run uses stand-ins for all three: it
 * proves the harness and the engine's own code, and measures nothing about reply quality.
 * The two are never mixed.
 */

export const DEFAULT_CUSTOMER_MODEL = "claude-opus-5-5";
export const DEFAULT_CUSTOMER_EFFORT: EffortLevel = "low";
export const DEFAULT_JUDGE_MODEL = "claude-opus-5-5";
export const DEFAULT_JUDGE_EFFORT: EffortLevel = "high";

export interface ModelRole {
  readonly client: ModelClient;
  /** The model id asked for. */
  readonly model: string;
  readonly effort: EffortLevel;
}

export interface EvalModels {
  readonly mode: RunMode;
  /** The client behind the engine. The model id comes from each scenario's settings. */
  readonly engine: ModelClient;
  /** What the engine's model is called in reports. */
  readonly engineLabel: string;
  readonly customer: ModelRole;
  readonly judge: ModelRole;
}

export interface ModelChoices {
  readonly customerModel?: string;
  readonly customerEffort?: EffortLevel;
  readonly judgeModel?: string;
  readonly judgeEffort?: EffortLevel;
}

export function mockModels(): EvalModels {
  return {
    mode: "mock",
    engine: createOfflineModelClient(),
    engineLabel: OFFLINE_MODEL_ID,
    customer: {
      client: createStandInCustomerModel(),
      model: STAND_IN_CUSTOMER_MODEL,
      effort: "low",
    },
    judge: { client: createStandInJudgeModel(), model: STAND_IN_JUDGE_MODEL, effort: "low" },
  };
}

export function liveModels(
  credentials: { readonly apiKey: string | undefined; readonly baseUrl?: string | undefined },
  choices: ModelChoices = {},
): EvalModels {
  if (credentials.apiKey === undefined) {
    throw new ConfigError(
      "A live evaluation needs ANTHROPIC_API_KEY (docs/HUMAN_TODO.md, entry 2). Without it, run in mock mode.",
      { details: { variables: ["ANTHROPIC_API_KEY"] } },
    );
  }
  const client = createAnthropicModelClient({
    apiKey: credentials.apiKey,
    ...(credentials.baseUrl === undefined ? {} : { baseUrl: credentials.baseUrl }),
  });
  return {
    mode: "live",
    engine: client,
    engineLabel: DEFAULT_MODEL,
    customer: {
      client,
      model: choices.customerModel ?? DEFAULT_CUSTOMER_MODEL,
      effort: choices.customerEffort ?? DEFAULT_CUSTOMER_EFFORT,
    },
    judge: {
      client,
      model: choices.judgeModel ?? DEFAULT_JUDGE_MODEL,
      effort: choices.judgeEffort ?? DEFAULT_JUDGE_EFFORT,
    },
  };
}
