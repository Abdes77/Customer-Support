import { ConfigError, logger as rootLogger, type Logger } from "@repo/core";
import { type DeploymentInfo, deploymentInfo, type Env, getEnv } from "@repo/core/env";

import { createAnthropicModelClient } from "./anthropic-client";
import { createOfflineModelClient } from "./offline";
import type { ModelClient } from "./types";

/**
 * Which model client a deployment uses.
 * - "live": the Claude API, with `ANTHROPIC_API_KEY`.
 * - "offline": the built-in rule-based stand-in. Only on a developer machine or in CI, when
 *   no key is set or `AI_MODEL_MODE=offline` asks for it.
 * - "unconfigured": a hosted deployment without a key. Every call fails with a ConfigError,
 *   so the turn is dead-lettered and an alert raised instead of a customer getting a canned
 *   answer from a fake model.
 */
export type ModelMode = "live" | "offline" | "unconfigured";

export function modelModeFromEnv(
  env: Env = getEnv(),
  deployment: DeploymentInfo = deploymentInfo(),
): ModelMode {
  const hosted = deployment.environment === "production" || deployment.environment === "preview";
  const hasKey = env.ANTHROPIC_API_KEY !== undefined;
  if (env.AI_MODEL_MODE === "offline" && !hosted) return "offline";
  if (hasKey) return "live";
  if (env.AI_MODEL_MODE === "live" || hosted) return "unconfigured";
  return "offline";
}

function unconfiguredModelClient(): ModelClient {
  return {
    name: "unconfigured",
    async call() {
      throw new ConfigError(
        "The Claude API is not configured: set ANTHROPIC_API_KEY. See docs/HUMAN_TODO.md.",
        { details: { variables: ["ANTHROPIC_API_KEY"] } },
      );
    },
  };
}

/** The model client for this deployment, chosen from the environment. */
export function createModelClientFromEnv(
  options: {
    readonly env?: Env;
    readonly deployment?: DeploymentInfo;
    readonly logger?: Logger;
  } = {},
): ModelClient {
  const env = options.env ?? getEnv();
  const deployment = options.deployment ?? deploymentInfo();
  const mode = modelModeFromEnv(env, deployment);
  const logger = (options.logger ?? rootLogger).child({ component: "model-client" });
  if (mode === "live" && env.ANTHROPIC_API_KEY !== undefined) {
    return createAnthropicModelClient({
      apiKey: env.ANTHROPIC_API_KEY,
      ...(env.ANTHROPIC_BASE_URL === undefined ? {} : { baseUrl: env.ANTHROPIC_BASE_URL }),
    });
  }
  if (mode === "offline") {
    logger.warn("model.offline", {
      reason:
        env.AI_MODEL_MODE === "offline" ? "AI_MODEL_MODE=offline" : "ANTHROPIC_API_KEY is not set",
    });
    return createOfflineModelClient();
  }
  logger.error("model.unconfigured", { variables: ["ANTHROPIC_API_KEY"] });
  return unconfiguredModelClient();
}
