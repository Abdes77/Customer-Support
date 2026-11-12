import { randomBytes } from "node:crypto";

import { createModelClientFromEnv, type ModelMode, modelModeFromEnv } from "@repo/ai";
import { createGraphClient, type FetchLike } from "@repo/channel-meta";
import { createInstagramAdapter, createMessengerAdapter } from "@repo/channel-messenger-instagram";
import {
  createMetaPagesEventHandler,
  createMetaPagesService,
  type MetaPagesService,
  metaChannelGuard,
} from "@repo/channel-messenger-instagram/server";
import { createTestChannelAdapter, type TestChannelAdapter } from "@repo/channel-test";
import { createWhatsAppAdapter, type MediaReader } from "@repo/channel-whatsapp";
import {
  type ConnectionService,
  createConnectionService,
  createDeepgramTranscriber,
  createVoiceMessageEnricher,
  createWhatsAppEventHandler,
  createWhatsAppJobs,
  createWhatsAppWindowFallback,
} from "@repo/channel-whatsapp/server";
import { createRealtimeNotifier, createWidgetAdapter, silentNotifier } from "@repo/channel-widget";
import { createWidgetService, type WidgetService } from "@repo/channel-widget/server";
import {
  type BusinessId,
  type AgencyId,
  type ChannelAdapter,
  ConfigError,
  logger as rootLogger,
  type Logger,
  NotFoundError,
} from "@repo/core";
import { type DeploymentInfo, deploymentInfo, type Env, getEnv, hasEnv } from "@repo/core/env";
import { type BusinessTenant, type Database, getDatabase } from "@repo/db";
import { getTenantStorage, type TenantStorage } from "@repo/db/storage";
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
import {
  createKnowledgeJobs,
  createKnowledgeServices,
  type KnowledgeServices,
} from "@repo/knowledge";
import { createLeadJobs } from "@repo/leads";
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
 *
 * Registered so far besides the pipeline's own jobs: `knowledge-playbook-generate` and
 * `knowledge-import` (C6), and the knowledge services the admin panel and the import API use;
 * `leads-outbox` (C5); `whatsapp-template-sync` (C9). Channel adapters: the test channel (C3),
 * the website chat (C8), whose public API service (`widget`) serves `/api/widget/v1`, and
 * WhatsApp (C9) with its window fallback, account-event handler and voice-message enricher,
 * and the connection services (`whatsapp`) behind Embedded Signup and the admin panel;
 * Messenger and Instagram (C10) with their account-event handlers and channel guard, and the
 * connection services (`metaPages`) behind Facebook Login and the admin panel.
 */
export interface ServerPipeline {
  readonly pipeline: Pipeline;
  readonly mode: JobsMode;
  /** Which model writes the replies: the Claude API, the offline stand-in, or nothing. */
  readonly modelMode: ModelMode;
  /** Every durable function of the app. */
  readonly jobs: readonly JobDefinition[];
  /** Where events go: Inngest, the in-process runner, or an error when neither is configured. */
  readonly events: EventSender;
  /** Playbooks, business knowledge and API keys, for the admin panel and the import API (C6). */
  readonly knowledge: KnowledgeServices;
  /** Set when jobs run on Inngest (Cloud or the dev server); /api/inngest serves them. */
  readonly inngest: InngestClient | null;
  /** Set when jobs run in this process (local development without Inngest). */
  readonly runner: LocalJobRunner | null;
  /** Null when this deployment has no test channel (hosted without TEST_CHANNEL_SECRET). */
  readonly testChannel: { readonly adapter: TestChannelAdapter; readonly secret: string } | null;
  /** The website chat's public API; null on a hosted deployment without WIDGET_SESSION_SECRET. */
  readonly widget: WidgetService | null;
  /**
   * WhatsApp connections and templates for the admin panel and the Embedded Signup route
   * (C9); null when the deployment has no Meta app (`META_APP_SECRET`,
   * `META_WEBHOOK_VERIFY_TOKEN`).
   */
  readonly whatsapp: ConnectionService | null;
  /**
   * Facebook Pages and Instagram accounts for the admin panel and the Facebook Login route
   * (C10); null when the deployment has no Meta app.
   */
  readonly metaPages: MetaPagesService | null;
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
  /** Tests inject a fixed widget session secret. */
  readonly widgetSecret?: string;
  /** Tests inject file storage. */
  readonly storage?: (tenant: BusinessTenant) => TenantStorage;
  /** Tests inject a fake Graph API (and the speech-to-text service) behind this fetch. */
  readonly metaFetch?: FetchLike;
}

/**
 * Reads the file of an outbound media message for the Meta adapters (WhatsApp, Messenger,
 * Instagram). The path is in the
 * tenant's folder (`{agency}/{business}/...`); it must be the connection's own business.
 */
function storageMediaReader(storage: (tenant: BusinessTenant) => TenantStorage): MediaReader {
  return async (connection, location) => {
    const [agencyId, businessId] = location.path.split("/");
    if (agencyId === undefined || businessId !== connection.businessId) {
      throw new NotFoundError("The file is not in this business's storage.");
    }
    const tenant = { agencyId: agencyId as AgencyId, businessId: businessId as BusinessId };
    const file = await storage(tenant).get(location.path);
    if (file === null) throw new NotFoundError("The file to send is missing.");
    return {
      bytes: file.bytes,
      mimeType: file.contentType,
      fileName: location.path.split("/").at(-1) ?? "file",
    };
  };
}

// The local test-channel secret when none is configured: valid for this process only, which
// is all the in-process dev chat page needs.
const processTestSecret = randomBytes(32).toString("base64url");
// The same for website-chat sessions: a local visitor starts a new session after a restart.
const processWidgetSecret = randomBytes(32).toString("base64url");

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
  // The website chat (C8). Live pokes go through Supabase Realtime when the project is
  // configured; otherwise the visitor's browser polls.
  const widgetSecret =
    options.widgetSecret ??
    env.WIDGET_SESSION_SECRET ??
    (deployment.environment === "local" ? processWidgetSecret : undefined);
  const realtime = hasEnv(
    env,
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  )
    ? {
        url: env.NEXT_PUBLIC_SUPABASE_URL!,
        apiKey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY!,
      }
    : null;
  const widgetAdapter =
    widgetSecret === undefined
      ? null
      : createWidgetAdapter({
          secret: widgetSecret,
          notifier:
            realtime === null
              ? silentNotifier
              : createRealtimeNotifier({
                  url: realtime.url,
                  serviceRoleKey: realtime.serviceRoleKey,
                }),
          logger,
        });
  const storage = options.storage ?? getTenantStorage;
  // WhatsApp (C9): on when the Meta app's webhook secrets are configured.
  const whatsappConfigured = hasEnv(env, "META_APP_SECRET", "META_WEBHOOK_VERIFY_TOKEN");
  const graph = whatsappConfigured
    ? createGraphClient({
        version: env.META_GRAPH_API_VERSION,
        ...(options.metaFetch === undefined ? {} : { fetch: options.metaFetch }),
      })
    : null;
  const whatsappDeps =
    graph === null
      ? null
      : {
          db,
          graph,
          logger: logger.child({ component: "whatsapp" }),
          app:
            env.META_APP_ID === undefined || env.META_APP_SECRET === undefined
              ? null
              : { appId: env.META_APP_ID, appSecret: env.META_APP_SECRET },
          signupConfigId: env.META_WHATSAPP_SIGNUP_CONFIG_ID ?? null,
        };
  const whatsappAdapter =
    whatsappDeps === null
      ? null
      : createWhatsAppAdapter({
          appSecret: env.META_APP_SECRET!,
          verifyToken: env.META_WEBHOOK_VERIFY_TOKEN!,
          graph: whatsappDeps.graph,
          media: storageMediaReader(storage),
          logger: whatsappDeps.logger,
        });

  // Messenger and Instagram (C10): the same Meta app, webhooks and Graph client as WhatsApp.
  const metaPagesDeps =
    graph === null
      ? null
      : {
          db,
          graph,
          logger: logger.child({ component: "meta-pages" }),
          app: whatsappDeps?.app ?? null,
          loginConfigId: env.META_LOGIN_CONFIG_ID ?? null,
        };
  const metaAdapterOptions =
    metaPagesDeps === null
      ? null
      : {
          appSecret: env.META_APP_SECRET!,
          verifyToken: env.META_WEBHOOK_VERIFY_TOKEN!,
          graph: metaPagesDeps.graph,
          // Echoes of our own sends carry this id; any other is a person in Meta's inbox.
          appId: env.META_APP_ID ?? null,
          media: storageMediaReader(storage),
          logger: metaPagesDeps.logger,
        };

  const channelAdapters: ChannelAdapter[] = [];
  if (testChannel !== null) channelAdapters.push(testChannel.adapter);
  if (widgetAdapter !== null) channelAdapters.push(widgetAdapter);
  if (whatsappAdapter !== null) channelAdapters.push(whatsappAdapter);
  if (metaAdapterOptions !== null) {
    channelAdapters.push(
      createMessengerAdapter(metaAdapterOptions),
      createInstagramAdapter(metaAdapterOptions),
    );
  }
  const adapters = createAdapterRegistry(channelAdapters);

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
  const transcriber =
    env.DEEPGRAM_API_KEY === undefined
      ? null
      : createDeepgramTranscriber({
          apiKey: env.DEEPGRAM_API_KEY,
          ...(options.metaFetch === undefined ? {} : { fetch: options.metaFetch }),
        });
  const pipeline = createPipeline({
    db,
    adapters,
    events,
    logger,
    model,
    ...(options.storage === undefined ? {} : { storage: options.storage }),
    // Channel parts of WhatsApp (C9): templates outside the 24-hour window, template and
    // account webhooks, voice messages.
    // Messenger and Instagram (C10): policy events per account, and the guard that leaves
    // story replies (per setting) and conversations another app controls to the team.
    ...(whatsappDeps === null || metaPagesDeps === null
      ? {}
      : {
          windowFallbacks: [createWhatsAppWindowFallback(whatsappDeps)],
          providerEvents: [
            createWhatsAppEventHandler(whatsappDeps),
            createMetaPagesEventHandler(metaPagesDeps, "messenger"),
            createMetaPagesEventHandler(metaPagesDeps, "instagram"),
          ],
          attachmentEnrichers: [createVoiceMessageEnricher({ transcriber })],
          channelGuards: [metaChannelGuard],
        }),
  });
  const widget =
    widgetSecret === undefined
      ? null
      : createWidgetService({
          db,
          ingest: (parsed) => pipeline.ingest(parsed),
          storage,
          secret: widgetSecret,
          realtime: realtime === null ? null : { url: realtime.url, apiKey: realtime.apiKey },
          logger,
        });
  // Without a key on a developer machine a playbook is the built-in starter document and
  // website facts come from structured data only; a hosted deployment without a key fails
  // those jobs instead (the model client throws a configuration error).
  const knowledgeJobs = createKnowledgeJobs({ db, model, modelMode, logger });
  const knowledge = createKnowledgeServices({ db, events, logger });
  // `leads-outbox` sends lead events a failed turn left behind (C5).
  const leadJobs = createLeadJobs({ db, events, logger });
  // `whatsapp-template-sync` (C9).
  const whatsappJobs = whatsappDeps === null ? [] : createWhatsAppJobs(whatsappDeps);
  const jobs = [...pipeline.jobs(), ...knowledgeJobs, ...leadJobs, ...whatsappJobs];
  if (runner !== null) runner.register(jobs);
  logger.info("pipeline.ready", {
    jobs: mode,
    model: modelMode,
    channels: adapters.channels(),
    testChannel: testChannel !== null,
    widget: widget === null ? "off" : realtime === null ? "polling" : "realtime",
    whatsapp: whatsappDeps !== null,
    messengerInstagram: metaPagesDeps !== null,
  });
  return {
    pipeline,
    mode,
    modelMode,
    jobs,
    events,
    knowledge,
    inngest,
    runner,
    testChannel,
    widget,
    whatsapp: whatsappDeps === null ? null : createConnectionService(whatsappDeps),
    metaPages: metaPagesDeps === null ? null : createMetaPagesService(metaPagesDeps),
  };
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
