import { randomBytes } from "node:crypto";

import { createModelClientFromEnv, type ModelMode, modelModeFromEnv } from "@repo/ai";
import { createTestChannelAdapter, type TestChannelAdapter } from "@repo/channel-test";
import { ConfigError, logger as rootLogger, type Logger } from "@repo/core";
import { type DeploymentInfo, deploymentInfo, type Env, getEnv } from "@repo/core/env";
import { type Database, getDatabase } from "@repo/db";
import {
  createInngestClient,
  createInngestEventSender,
  createLocalJobRunner,
  type EventSender,
  type InngestClient,
  inngestDevAllowed,
  type JobDefinition,
  type JobsMode,
  jobsModeFromEnv,
  type LocalJobRunner,
  toInngestFunctions,
} from "@repo/jobs";
import { createAdapterRegistry, createPipeline, type Pipeline } from "@repo/pipeline";

/**
 * The infrastructure composition root (ARCHITECTURE §6): which channel adapters this
 * deployment has, which database, which job runner and which model endpoint (the Claude API,
 * or the offline stand-in on a developer machine without a key). `@repo/pipeline` wires the
 * domain (engine, action handlers, loaders); this file plugs it into the infrastructure.
 *
 * Later chunks register here: their channel adapters (C8 to C11) in `adapters` and their job
 * definitions (C11 to C14, C17) next to the pipeline's in `jobs`. Domain parts (engine, action
 * handlers, knowledge) are registered in `packages/pipeline/src/composition` instead.
 */
export interface ServerPipeline {
  readonly pipeline: Pipeline;
  readonly mode: JobsMode;
  /** Which model writes the replies: the Claude API, the offline stand-in, or nothing. */
  readonly modelMode: ModelMode;
  /** Every durable function of the app. */
  readonly jobs: readonly JobDefinition[];
  /** Set when jobs run on Inngest (Cloud or the dev server); /api/inngest serves them. */
  readonly inngest: InngestClient | null;
  /** Set when jobs run in this process (local development without Inngest). */
  readonly runner: LocalJobRunner | null;
  /** Null when this deployment has no test channel (hosted without TEST_CHANNEL_SECRET). */
  readonly testChannel: { readonly adapter: TestChannelAdapter; readonly secret: string } | null;
}

export interface ServerPipelineOptions {
  readonly db: Database;
  readonly env: Env;
  readonly deployment: DeploymentInfo;
  readonly logger?: Logger;
  /** Tests inject a runner with short delays. */
  readonly runner?: LocalJobRunner;
  /** Tests inject a fixed test-channel secret. */
  readonly testChannelSecret?: string;
}

// The local test-channel secret when none is configured: valid for this process only, which
// is all the in-process dev chat page needs.
const processTestSecret = randomBytes(32).toString("base64url");

function unconfiguredSender(): EventSender {
  return {
    async send() {
      throw new ConfigError(
        "Background jobs are not configured: set INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY. See docs/HUMAN_TODO.md.",
        { details: { variables: ["INNGEST_EVENT_KEY", "INNGEST_SIGNING_KEY"] } },
      );
    },
  };
}

export function buildServerPipeline(options: ServerPipelineOptions): ServerPipeline {
  const { db, env, deployment } = options;
  const logger = (options.logger ?? rootLogger).child({ component: "server-pipeline" });
  const mode = jobsModeFromEnv(env, deployment);

  const testSecret =
    options.testChannelSecret ??
    env.TEST_CHANNEL_SECRET ??
    (deployment.environment === "local" ? processTestSecret : undefined);
  const testChannel =
    testSecret === undefined
      ? null
      : { adapter: createTestChannelAdapter({ secret: testSecret }), secret: testSecret };
  const adapters = createAdapterRegistry(testChannel === null ? [] : [testChannel.adapter]);

  const inngest =
    mode === "inngest"
      ? createInngestClient({
          ...(env.INNGEST_EVENT_KEY === undefined ? {} : { eventKey: env.INNGEST_EVENT_KEY }),
          // Always explicit, so the SDK never reads INNGEST_DEV itself: in dev mode it does
          // not verify request signatures, which a hosted deployment must never skip.
          isDev: inngestDevAllowed(env, deployment),
          ...(env.INNGEST_BASE_URL === undefined ? {} : { baseUrl: env.INNGEST_BASE_URL }),
          ...(deployment.commitSha === null ? {} : { appVersion: deployment.commitSha }),
        })
      : null;
  const runner = mode === "local" ? (options.runner ?? createLocalJobRunner({ logger })) : null;
  const events: EventSender =
    inngest !== null ? createInngestEventSender(inngest) : (runner ?? unconfiguredSender());

  // The engine, action handlers, knowledge and loaders come from the pipeline's domain
  // composition (packages/pipeline/src/composition), where C4 to C13 register theirs. The
  // model client is infrastructure: it is chosen here, from this deployment's environment.
  const modelMode = modelModeFromEnv(env, deployment);
  const model = createModelClientFromEnv({ env, deployment, logger });
  const pipeline = createPipeline({ db, adapters, events, logger, model });
  const jobs = [...pipeline.jobs()];
  if (runner !== null) runner.register(jobs);
  logger.info("pipeline.ready", {
    jobs: mode,
    model: modelMode,
    channels: adapters.channels(),
    testChannel: testChannel !== null,
  });
  return { pipeline, mode, modelMode, jobs, inngest, runner, testChannel };
}

// One per process, kept on globalThis so a hot reload of the dev server does not start a
// second local runner.
const SHARED = Symbol.for("@repo/web/server-pipeline");
const holder = globalThis as { [SHARED]?: ServerPipeline };

/** The process-wide pipeline, built on first use from the environment. */
export function getServerPipeline(): ServerPipeline {
  let server = holder[SHARED];
  if (server === undefined) {
    server = buildServerPipeline({
      db: getDatabase(),
      env: getEnv(),
      deployment: deploymentInfo(),
    });
    server.runner?.startCrons();
    holder[SHARED] = server;
  }
  return server;
}

/** The Inngest functions /api/inngest serves, built once per process. */
const FUNCTIONS = Symbol.for("@repo/web/inngest-functions");
const functionsHolder = globalThis as { [FUNCTIONS]?: ReturnType<typeof toInngestFunctions> };

export function inngestFunctions(server: ServerPipeline): ReturnType<typeof toInngestFunctions> {
  if (server.inngest === null) return [];
  functionsHolder[FUNCTIONS] ??= toInngestFunctions(server.inngest, server.jobs, {
    logger: rootLogger,
  });
  return functionsHolder[FUNCTIONS];
}
