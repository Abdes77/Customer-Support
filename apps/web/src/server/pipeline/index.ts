import { hkdfSync, randomBytes } from "node:crypto";

import { createModelClientFromEnv, type ModelMode, modelModeFromEnv } from "@repo/ai";
import { createGraphClient, type FetchLike } from "@repo/channel-meta";
import { createInstagramAdapter, createMessengerAdapter } from "@repo/channel-messenger-instagram";
import {
  createMetaPagesEventHandler,
  createMetaPagesService,
  type MetaPagesService,
  metaChannelGuard,
} from "@repo/channel-messenger-instagram/server";
import {
  createEmailAdapter,
  createGmailClient,
  createGraphMailClient,
  type FetchLike as EmailFetch,
  type MailNetworkPolicy,
} from "@repo/channel-email";
import {
  createAccessTokens,
  createEmailComposer,
  createEmailConnectionService,
  createEmailJobs,
  createEmailSendThrottle,
  createGmailPushHandler,
  createGraphNotificationHandler,
  emailChannelGuard,
  type EmailConnectionService,
  type EmailJobOptions,
  type EmailServerDeps,
  type JsonWebKeySet,
  publicUrl,
  ROUTES as EMAIL_ROUTES,
} from "@repo/channel-email/server";
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
  type AlertTransports,
  alertTransportsFromEnv,
  createHandoffJobs,
  createHandoffService,
  createTwilioWebhookHandlers,
  type HandoffDeps,
  type HandoffService,
  type TwilioWebhookHandlers,
} from "@repo/handoff";
import {
  createIntegrationJobs,
  createIntegrationService,
  createSafePoster,
  type FetchLike as IntegrationFetch,
  integrationConfigFromEnv,
  type IntegrationDeps,
  type IntegrationService,
  type SafePoster,
} from "@repo/integrations";
import {
  createKnowledgeJobs,
  createKnowledgeServices,
  type KnowledgeServices,
} from "@repo/knowledge";
import { createLeadJobs } from "@repo/leads";
import {
  createAdapterRegistry,
  createPipeline,
  enqueueBotMessage,
  enqueueHumanMessage,
  type Pipeline,
} from "@repo/pipeline";
import {
  createCalendlyWebhookHandler,
  createSchedulingConnectionService,
  createSchedulingJobs,
  type FetchLike as SchedulingFetch,
  type SchedulingConnectionService,
  schedulingConfigFromEnv,
  type SchedulingDeps,
} from "@repo/scheduling";

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
 * connection services (`metaPages`) behind Facebook Login and the admin panel; email (C11)
 * with its composer, send throttle and channel guard, the jobs `email-sync`, `email-poll` and
 * `email-watch-renew`, the Gmail and Graph notification handlers and the connection services
 * (`email`) behind the OAuth routes, the IMAP connect route and the admin panel; scheduling
 * (C12): the jobs `scheduling-reminders`, `scheduling-meeting-requested` and
 * `scheduling-reminder-sweep`, the calendar connection services (`scheduling`) behind the
 * calendar OAuth routes, the Calendly token route and the admin panel, and the Calendly
 * webhook handler. The scheduling action handlers are domain parts: the pipeline's
 * composition registers them, with this deployment's OAuth apps and `fetch`. Handoff (C13):
 * the alert subscribers, the emergency start and chain, the idle takeover release, the
 * follow-ups and the sweeper (`handoff-*`), with this deployment's alert transports (Twilio,
 * SMTP, the agency's WhatsApp number); the admin panel's service (`handoff.service`) and the
 * handlers of Twilio's callbacks (`handoff.twilio`). Its action handlers, observers, guard and
 * send gate are domain parts registered by the pipeline's composition. Integrations (C14):
 * the subscribers to `lead.*` and `scheduling.booking_changed`, the deliveries to CRMs and
 * outgoing webhooks with their backoff, and the sweeper (`integrations-*`), with this
 * deployment's CRM apps; the admin panel's service (`integrations`) behind the CRM connect
 * routes.
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
  /**
   * Email (C11): the inbox connections for the admin panel and the connect routes, and the
   * handlers of the two notification routes. IMAP/SMTP needs no vendor account; Gmail and
   * Microsoft 365 are offered when their OAuth apps are configured.
   */
  readonly email: ServerEmail;
  /** Calendars and Calendly (C12). Google, Outlook and Calendly OAuth need their apps. */
  readonly scheduling: ServerScheduling;
  /** Takeover, emergencies, alerts and follow-ups (C13). */
  readonly handoff: ServerHandoff;
  /** CRMs and outgoing webhooks (C14): what the admin panel and the connect routes call. */
  readonly integrations: IntegrationService;
}

export interface ServerHandoff {
  /** What the admin panel calls (C15, C16), after checking the person's role. */
  readonly service: HandoffService;
  /** Twilio's callbacks: replies to alert texts, keypresses, delivery statuses. */
  readonly twilio: TwilioWebhookHandlers;
  /** The package's own dependencies, for the acknowledgement page. */
  readonly deps: HandoffDeps;
}

export interface ServerScheduling {
  readonly connections: SchedulingConnectionService;
  readonly calendlyWebhook: ReturnType<typeof createCalendlyWebhookHandler>;
}

export interface ServerEmail {
  readonly connections: EmailConnectionService;
  readonly gmailPush: ReturnType<typeof createGmailPushHandler>;
  readonly graphNotifications: ReturnType<typeof createGraphNotificationHandler>;
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
  /** Tests inject fakes of the Gmail API, Microsoft Graph and their OAuth endpoints. */
  readonly emailFetch?: EmailFetch;
  /** Tests widen the mail-server address rules to reach a local IMAP/SMTP server. */
  readonly mailPolicy?: MailNetworkPolicy;
  /** Tests inject Google's signing keys for Pub/Sub push tokens. */
  readonly googleKeys?: () => Promise<JsonWebKeySet>;
  /** Tests shorten the debounce of `email-sync`. */
  readonly emailJobs?: EmailJobOptions;
  /** Tests inject fakes of Google Calendar, Microsoft Graph, Calendly and their OAuth. */
  readonly schedulingFetch?: SchedulingFetch;
  /** Tests inject recording alert transports (Twilio, SMTP, WhatsApp). */
  readonly alertTransports?: AlertTransports;
  /** Tests inject a clock for handoff's timing. */
  readonly clock?: () => Date;
  /** Tests inject fakes of the CRMs' APIs and OAuth endpoints. */
  readonly integrationsFetch?: IntegrationFetch;
  /** Tests inject a poster that reaches a local webhook receiver. */
  readonly webhookPoster?: SafePoster;
}

/**
 * The key that signs the email OAuth `state`, derived from the credentials key with HKDF so
 * no other secret has to be configured (a different purpose label than the encryption).
 */
function oauthStateKey(env: Env): Uint8Array | null {
  if (env.CREDENTIALS_ENCRYPTION_KEY === undefined) return null;
  return new Uint8Array(
    hkdfSync(
      "sha256",
      Buffer.from(env.CREDENTIALS_ENCRYPTION_KEY, "base64"),
      Buffer.alloc(0),
      "hsrb/email-oauth-state/v1",
      32,
    ),
  );
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

  // Email (C11). The adapter sends through Gmail, Graph or SMTP; inbound mail comes from the
  // sync job, which calls the pipeline's ingest (bound once the pipeline exists).
  const emailFetch: EmailFetch = options.emailFetch ?? ((input, init) => fetch(input, init));
  let ingestEmail: EmailServerDeps["ingest"] = () =>
    Promise.reject(new Error("The pipeline is not ready yet."));
  const appUrl = env.APP_URL ?? "http://localhost:3000";
  const emailDeps: EmailServerDeps = {
    db,
    logger: logger.child({ component: "email" }),
    gmail: createGmailClient(emailFetch),
    graph: createGraphMailClient(emailFetch),
    fetch: emailFetch,
    google:
      env.GOOGLE_CLIENT_ID === undefined || env.GOOGLE_CLIENT_SECRET === undefined
        ? null
        : {
            app: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
            pubsubTopic: env.GOOGLE_PUBSUB_TOPIC ?? null,
            pushServiceAccount: env.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT ?? null,
            pushAudience:
              env.GOOGLE_PUBSUB_PUSH_AUDIENCE ?? publicUrl(appUrl, EMAIL_ROUTES.gmailPush),
          },
    microsoft:
      env.MICROSOFT_CLIENT_ID === undefined || env.MICROSOFT_CLIENT_SECRET === undefined
        ? null
        : {
            app: {
              clientId: env.MICROSOFT_CLIENT_ID,
              clientSecret: env.MICROSOFT_CLIENT_SECRET,
              tenant: env.MICROSOFT_TENANT_ID,
            },
            clientStateSecret: env.MICROSOFT_GRAPH_CLIENT_STATE ?? null,
          },
    appUrl,
    oauthStateKey: oauthStateKey(env),
    ingest: (parsed) => ingestEmail(parsed),
    events: {
      send: (list) => events.send(list),
    },
    storage,
    ...(options.mailPolicy === undefined ? {} : { mailPolicy: options.mailPolicy }),
    ...(options.googleKeys === undefined ? {} : { googleKeys: options.googleKeys }),
  };
  const emailTokens = createAccessTokens(emailDeps);
  const emailReader = storageMediaReader(storage);
  const emailAdapter = createEmailAdapter({
    accessToken: (connection) => emailTokens.forConnection(connection),
    gmail: emailDeps.gmail,
    graph: emailDeps.graph,
    media: emailReader,
    ...(options.mailPolicy === undefined ? {} : { mailPolicy: options.mailPolicy }),
    logger: emailDeps.logger,
  });

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
  channelAdapters.push(emailAdapter);
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
  // Calendars and Calendly (C12): the same OAuth apps as email, asked for calendar scopes.
  const schedulingConfig = {
    fetch: options.schedulingFetch ?? ((input: string, init?: RequestInit) => fetch(input, init)),
    ...schedulingConfigFromEnv(env),
  };
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
        }),
    // Email (C11): the business's email (greeting, signature, quote, HTML), the sending
    // limits per inbox, and the guard against automatic mail and loops.
    outboundComposers: [createEmailComposer()],
    sendThrottles: [createEmailSendThrottle()],
    channelGuards: [...(metaPagesDeps === null ? [] : [metaChannelGuard]), emailChannelGuard],
    // Scheduling (C12): the handlers in the domain composition call the calendars with this.
    scheduling: schedulingConfig,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const schedulingDeps: SchedulingDeps = {
    db,
    logger: logger.child({ component: "scheduling" }),
    events,
    ...schedulingConfig,
  };
  ingestEmail = (parsed) => pipeline.ingest(parsed);
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
  // `email-sync`, `email-poll`, `email-watch-renew` (C11).
  const emailJobs = createEmailJobs(emailDeps, options.emailJobs);
  // `scheduling-reminders`, `scheduling-meeting-requested`, `scheduling-reminder-sweep` (C12).
  // Reminders are stored and sent by the pipeline like any bot message.
  const schedulingJobs = createSchedulingJobs({
    ...schedulingDeps,
    outbound: { enqueue: enqueueBotMessage },
  });
  // Handoff (C13): alerts by text message, call, email and WhatsApp; the messages it puts in a
  // conversation (an opt-out confirmation, a person's reply) go through the pipeline.
  const handoffDeps: HandoffDeps = {
    db,
    logger: logger.child({ component: "handoff" }),
    events,
    appUrl,
    transports: options.alertTransports ?? alertTransportsFromEnv({ env }),
    outbound: { enqueueBot: enqueueBotMessage, enqueueHuman: enqueueHumanMessage },
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  };
  const handoffJobs = createHandoffJobs(handoffDeps);
  // CRMs and outgoing webhooks (C14): every webhook goes through the guarded poster.
  const integrationDeps: IntegrationDeps = {
    db,
    logger: logger.child({ component: "integrations" }),
    events,
    fetch: options.integrationsFetch ?? ((input: string, init?: RequestInit) => fetch(input, init)),
    poster: options.webhookPoster ?? createSafePoster(),
    ...integrationConfigFromEnv(env),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  };
  const integrationJobs = createIntegrationJobs(integrationDeps);
  const jobs = [
    ...pipeline.jobs(),
    ...knowledgeJobs,
    ...leadJobs,
    ...whatsappJobs,
    ...emailJobs,
    ...schedulingJobs,
    ...handoffJobs,
    ...integrationJobs,
  ];
  if (runner !== null) runner.register(jobs);
  logger.info("pipeline.ready", {
    jobs: mode,
    model: modelMode,
    channels: adapters.channels(),
    testChannel: testChannel !== null,
    widget: widget === null ? "off" : realtime === null ? "polling" : "realtime",
    whatsapp: whatsappDeps !== null,
    messengerInstagram: metaPagesDeps !== null,
    email: {
      gmail: emailDeps.google !== null,
      microsoft: emailDeps.microsoft !== null,
    },
    calendars: {
      google: schedulingConfig.google !== null,
      microsoft: schedulingConfig.microsoft !== null,
      calendlyOAuth: schedulingConfig.calendly.app !== null,
    },
    alerts: {
      sms: handoffDeps.transports.sms !== null,
      voice: handoffDeps.transports.voice !== null,
      email: handoffDeps.transports.email !== null,
      whatsapp: handoffDeps.transports.whatsapp !== null,
    },
    crms: {
      hubspot: integrationDeps.apps.hubspot !== null,
      gohighlevel: integrationDeps.apps.gohighlevel !== null,
      jobber: integrationDeps.apps.jobber !== null,
      servicetitan: integrationDeps.apps.servicetitan !== null,
    },
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
    email: {
      connections: createEmailConnectionService(emailDeps),
      gmailPush: createGmailPushHandler(emailDeps),
      graphNotifications: createGraphNotificationHandler(emailDeps),
    },
    scheduling: {
      connections: createSchedulingConnectionService(schedulingDeps),
      calendlyWebhook: createCalendlyWebhookHandler(schedulingDeps),
    },
    handoff: {
      service: createHandoffService(handoffDeps),
      twilio: createTwilioWebhookHandlers({
        ...handoffDeps,
        authToken: env.TWILIO_AUTH_TOKEN ?? null,
      }),
      deps: handoffDeps,
    },
    integrations: createIntegrationService(integrationDeps),
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
