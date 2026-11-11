import { z } from "zod";

/**
 * The single declaration of every environment variable the system reads.
 *
 * To add a variable: add it here, run `pnpm env:example`, and (when a person has to obtain the
 * value) add an entry to docs/HUMAN_TODO.md. A test fails when `.env.example` and this file
 * drift apart. Read variables with `getEnv()` or `requireEnv()`, never `process.env` directly
 * (the only exception is `NEXT_PUBLIC_*` in browser code, which Next.js inlines at build time).
 */

/**
 * production: the product cannot run without it.
 * feature: needed only for the named channel or integration; code must degrade to mocks or a
 *          clear "not configured" state when it is missing.
 * optional: has a sensible default or is a convenience.
 */
export type EnvRequirement = "production" | "feature" | "optional";

export interface EnvVarSpec {
  readonly schema: z.ZodType;
  readonly group: EnvGroupId;
  readonly description: string;
  /** Shown in .env.example. Never a real secret; leave empty for secrets. */
  readonly example: string;
  readonly secret: boolean;
  readonly required: EnvRequirement;
  /** Applied when the variable is unset. Its presence makes the loaded value non-optional. */
  readonly default?: string;
}

export const ENV_GROUPS = [
  { id: "app", title: "Application" },
  { id: "supabase", title: "Supabase and PostgreSQL (C1)" },
  { id: "security", title: "Application-layer secrets (C1, C8)" },
  { id: "anthropic", title: "Claude API (C4, C6, C7)" },
  { id: "inngest", title: "Inngest (C3)" },
  { id: "meta", title: "Meta: WhatsApp, Instagram, Messenger (C9, C10)" },
  { id: "google", title: "Google: Gmail and Calendar (C11, C12)" },
  { id: "microsoft", title: "Microsoft: Outlook mail and calendar (C11, C12)" },
  { id: "twilio", title: "Twilio: SMS and voice alerts (C13)" },
  { id: "alerts", title: "Alert delivery by email and WhatsApp (C13)" },
  { id: "calendly", title: "Calendly (C12)" },
  { id: "crm", title: "CRM connectors (C14)" },
  { id: "observability", title: "Observability (C17)" },
] as const;

export type EnvGroupId = (typeof ENV_GROUPS)[number]["id"];

const nonEmpty = z.string().min(1);
const url = z.url();
const flag = z.enum(["0", "1"]).transform((value) => value === "1");

/** A base64-encoded 32-byte key, as produced by `openssl rand -base64 32`. */
const aes256Key = z.string().refine(
  // Buffer.from(..., "base64") silently skips characters outside the alphabet, so check the
  // alphabet first; otherwise a mistyped key could decode to 32 different bytes.
  (value) => /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, "base64").length === 32,
  "must be 32 bytes, base64-encoded (openssl rand -base64 32)",
);

export const ENV_SPEC = {
  // --- app -------------------------------------------------------------------------------
  APP_URL: {
    schema: url,
    group: "app",
    description:
      "Public origin of the deployment. Used for webhook callbacks, OAuth redirects and links in alerts.",
    example: "http://localhost:3000",
    secret: false,
    required: "production",
  },
  NEXT_PUBLIC_APP_URL: {
    schema: url,
    group: "app",
    description: "Same origin as APP_URL, exposed to the browser and the embeddable widget.",
    example: "http://localhost:3000",
    secret: false,
    required: "production",
  },
  LOG_LEVEL: {
    schema: z.enum(["debug", "info", "warn", "error"]),
    group: "app",
    description: "Minimum level written by the structured logger.",
    example: "info",
    secret: false,
    required: "optional",
    default: "info",
  },

  // --- supabase --------------------------------------------------------------------------
  NEXT_PUBLIC_SUPABASE_URL: {
    schema: url,
    group: "supabase",
    description: "Supabase project URL (Project Settings, API).",
    example: "https://your-project.supabase.co",
    secret: false,
    required: "production",
  },
  NEXT_PUBLIC_SUPABASE_ANON_KEY: {
    schema: nonEmpty,
    group: "supabase",
    description:
      "Supabase anon (publishable) key. Safe in the browser: row-level security applies.",
    example: "",
    secret: false,
    required: "production",
  },
  SUPABASE_SERVICE_ROLE_KEY: {
    schema: nonEmpty,
    group: "supabase",
    description: "Supabase service-role key. Bypasses row-level security: server only.",
    example: "",
    secret: true,
    required: "production",
  },
  SUPABASE_JWT_SECRET: {
    schema: nonEmpty,
    group: "supabase",
    description:
      "Supabase JWT secret, used to mint short-lived Realtime tokens for widget visitors.",
    example: "",
    secret: true,
    required: "feature",
  },
  DATABASE_URL: {
    schema: nonEmpty,
    group: "supabase",
    description:
      "PostgreSQL connection string for the app at runtime (Supabase pooler, transaction mode).",
    example: "postgresql://hsrb:hsrb@127.0.0.1:5432/hsrb_dev",
    secret: true,
    required: "production",
  },
  DATABASE_URL_DIRECT: {
    schema: nonEmpty,
    group: "supabase",
    description: "Direct PostgreSQL connection string, used only to run migrations.",
    example: "postgresql://hsrb:hsrb@127.0.0.1:5432/hsrb_dev",
    secret: true,
    required: "production",
  },
  TEST_DATABASE_URL: {
    schema: nonEmpty,
    group: "supabase",
    description: "Database that tests may create, migrate and wipe. Never point it at real data.",
    example: "postgresql://hsrb:hsrb@127.0.0.1:5432/hsrb_test",
    secret: true,
    required: "optional",
  },
  DATABASE_POOL_MAX: {
    schema: z.coerce.number().int().min(1).max(50),
    group: "supabase",
    description:
      "Connections each server instance may open to PostgreSQL. Keep it small on serverless.",
    example: "5",
    secret: false,
    required: "optional",
    default: "5",
  },
  SEED_USER_PASSWORD: {
    schema: z.string().min(12),
    group: "supabase",
    description:
      "Password that pnpm db:seed gives the demo users (at least 12 characters). Required to seed a Supabase database; a local database falls back to the documented demo password.",
    example: "",
    secret: true,
    required: "optional",
  },
  SUPABASE_STORAGE_BUCKET: {
    schema: nonEmpty,
    group: "supabase",
    description: "Private Storage bucket for customer photos and other attachments.",
    example: "attachments",
    secret: false,
    required: "optional",
    default: "attachments",
  },

  // --- security --------------------------------------------------------------------------
  CREDENTIALS_ENCRYPTION_KEY: {
    schema: aes256Key,
    group: "security",
    description:
      "AES-256-GCM key that encrypts stored OAuth tokens, page tokens and SMTP passwords. Generate with: openssl rand -base64 32",
    example: "",
    secret: true,
    required: "production",
  },
  CREDENTIALS_ENCRYPTION_KEY_ID: {
    schema: z.string().regex(/^[a-z0-9_-]{1,16}$/),
    group: "security",
    description: "Label stored with each ciphertext so keys can be rotated.",
    example: "k1",
    secret: false,
    required: "optional",
    default: "k1",
  },
  CREDENTIALS_ENCRYPTION_OLD_KEYS: {
    schema: nonEmpty,
    group: "security",
    description:
      "Retired keys still needed to decrypt old rows during rotation, as id:base64key pairs separated by commas.",
    example: "",
    secret: true,
    required: "optional",
  },
  LOCAL_AUTH_SECRET: {
    schema: z.string().min(32),
    group: "security",
    description:
      "Local development and CI only: switches on the built-in sign-in that stands in for Supabase Auth when no Supabase project is configured, and signs its session cookie (at least 32 characters). Ignored on Vercel. Never set it in production.",
    example: "",
    secret: true,
    required: "optional",
  },
  WIDGET_SESSION_SECRET: {
    schema: z.string().min(32),
    group: "security",
    description:
      "Signs website-widget visitor sessions (at least 32 characters). Generate with: openssl rand -base64 48",
    example: "",
    secret: true,
    required: "feature",
  },

  // --- anthropic -------------------------------------------------------------------------
  ANTHROPIC_API_KEY: {
    schema: nonEmpty,
    group: "anthropic",
    description:
      "Claude API key. The workspace needs 30-day data retention for claude-fable-5-2. Without it, tests and evals run against a mocked model.",
    example: "",
    secret: true,
    required: "production",
  },
  ANTHROPIC_BASE_URL: {
    schema: url,
    group: "anthropic",
    description: "Override the Claude API endpoint (proxies and tests only).",
    example: "",
    secret: false,
    required: "optional",
  },

  // --- inngest ---------------------------------------------------------------------------
  INNGEST_EVENT_KEY: {
    schema: nonEmpty,
    group: "inngest",
    description: "Inngest event key, used to send events.",
    example: "",
    secret: true,
    required: "production",
  },
  INNGEST_SIGNING_KEY: {
    schema: nonEmpty,
    group: "inngest",
    description: "Inngest signing key, used to authenticate calls to /api/inngest.",
    example: "",
    secret: true,
    required: "production",
  },
  INNGEST_SIGNING_KEY_FALLBACK: {
    schema: nonEmpty,
    group: "inngest",
    description: "Previous signing key, accepted during key rotation.",
    example: "",
    secret: true,
    required: "optional",
  },
  INNGEST_DEV: {
    schema: flag,
    group: "inngest",
    description: "Set to 1 to use the local Inngest dev server instead of Inngest Cloud.",
    example: "1",
    secret: false,
    required: "optional",
  },
  INNGEST_BASE_URL: {
    schema: url,
    group: "inngest",
    description: "URL of a self-run Inngest dev server, when it is not on the default port.",
    example: "",
    secret: false,
    required: "optional",
  },

  // --- meta ------------------------------------------------------------------------------
  META_APP_ID: {
    schema: nonEmpty,
    group: "meta",
    description: "Meta app id (developers.facebook.com, App settings, Basic).",
    example: "",
    secret: false,
    required: "feature",
  },
  NEXT_PUBLIC_META_APP_ID: {
    schema: nonEmpty,
    group: "meta",
    description: "Same Meta app id, exposed to the browser for Embedded Signup and Facebook Login.",
    example: "",
    secret: false,
    required: "feature",
  },
  META_APP_SECRET: {
    schema: nonEmpty,
    group: "meta",
    description: "Meta app secret. Verifies webhook signatures and exchanges login codes.",
    example: "",
    secret: true,
    required: "feature",
  },
  META_WEBHOOK_VERIFY_TOKEN: {
    schema: nonEmpty,
    group: "meta",
    description: "Any random string; entered again in the Meta webhook configuration screen.",
    example: "",
    secret: true,
    required: "feature",
  },
  META_GRAPH_API_VERSION: {
    schema: z.string().regex(/^v\d+\.\d+$/),
    group: "meta",
    description:
      "Graph API version used for every Meta call. Check Meta's changelog before raising it.",
    example: "v24.0",
    secret: false,
    required: "feature",
  },
  META_WHATSAPP_SIGNUP_CONFIG_ID: {
    schema: nonEmpty,
    group: "meta",
    description:
      "Configuration id of the WhatsApp Embedded Signup flow (Facebook Login for Business).",
    example: "",
    secret: false,
    required: "feature",
  },
  META_LOGIN_CONFIG_ID: {
    schema: nonEmpty,
    group: "meta",
    description:
      "Configuration id of the Facebook Login for Business flow that connects Pages and Instagram accounts.",
    example: "",
    secret: false,
    required: "feature",
  },
  META_TEST_WHATSAPP_PHONE_NUMBER_ID: {
    schema: nonEmpty,
    group: "meta",
    description: "Live check only: phone number id of the Meta test WhatsApp number.",
    example: "",
    secret: false,
    required: "optional",
  },
  META_TEST_WHATSAPP_ACCESS_TOKEN: {
    schema: nonEmpty,
    group: "meta",
    description: "Live check only: access token for the test WhatsApp number.",
    example: "",
    secret: true,
    required: "optional",
  },
  META_TEST_WHATSAPP_RECIPIENT: {
    schema: nonEmpty,
    group: "meta",
    description: "Live check only: your own phone number in E.164, registered as a test recipient.",
    example: "",
    secret: false,
    required: "optional",
  },
  META_TEST_PAGE_ID: {
    schema: nonEmpty,
    group: "meta",
    description: "Live check only: id of the test Facebook Page.",
    example: "",
    secret: false,
    required: "optional",
  },
  META_TEST_PAGE_ACCESS_TOKEN: {
    schema: nonEmpty,
    group: "meta",
    description: "Live check only: Page access token of the test Page.",
    example: "",
    secret: true,
    required: "optional",
  },
  META_TEST_INSTAGRAM_ACCOUNT_ID: {
    schema: nonEmpty,
    group: "meta",
    description: "Live check only: id of the test Instagram professional account.",
    example: "",
    secret: false,
    required: "optional",
  },

  // --- google ----------------------------------------------------------------------------
  GOOGLE_CLIENT_ID: {
    schema: nonEmpty,
    group: "google",
    description: "Google OAuth client id (Gmail and Google Calendar).",
    example: "",
    secret: false,
    required: "feature",
  },
  GOOGLE_CLIENT_SECRET: {
    schema: nonEmpty,
    group: "google",
    description: "Google OAuth client secret.",
    example: "",
    secret: true,
    required: "feature",
  },
  GOOGLE_PUBSUB_TOPIC: {
    schema: z.string().regex(/^projects\/[^/]+\/topics\/[^/]+$/),
    group: "google",
    description: "Pub/Sub topic that Gmail push notifications are published to.",
    example: "projects/your-project/topics/gmail-push",
    secret: false,
    required: "feature",
  },
  GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT: {
    schema: z.email(),
    group: "google",
    description:
      "Service account that signs Pub/Sub push requests; the Gmail webhook rejects any other sender.",
    example: "",
    secret: false,
    required: "feature",
  },

  // --- microsoft -------------------------------------------------------------------------
  MICROSOFT_CLIENT_ID: {
    schema: nonEmpty,
    group: "microsoft",
    description: "Microsoft Entra application (client) id for Outlook mail and calendar.",
    example: "",
    secret: false,
    required: "feature",
  },
  MICROSOFT_CLIENT_SECRET: {
    schema: nonEmpty,
    group: "microsoft",
    description: "Microsoft Entra client secret.",
    example: "",
    secret: true,
    required: "feature",
  },
  MICROSOFT_TENANT_ID: {
    schema: nonEmpty,
    group: "microsoft",
    description: 'Entra tenant; "common" accepts work, school and personal accounts.',
    example: "common",
    secret: false,
    required: "optional",
    default: "common",
  },
  MICROSOFT_GRAPH_CLIENT_STATE: {
    schema: z.string().min(16),
    group: "microsoft",
    description:
      "Random string sent with Graph subscriptions and checked on every change notification.",
    example: "",
    secret: true,
    required: "feature",
  },

  // --- twilio ----------------------------------------------------------------------------
  TWILIO_ACCOUNT_SID: {
    schema: nonEmpty,
    group: "twilio",
    description: "Twilio account SID.",
    example: "",
    secret: false,
    required: "feature",
  },
  TWILIO_AUTH_TOKEN: {
    schema: nonEmpty,
    group: "twilio",
    description: "Twilio auth token. Also verifies Twilio webhook signatures.",
    example: "",
    secret: true,
    required: "feature",
  },
  TWILIO_FROM_NUMBER: {
    schema: z.string().regex(/^\+[1-9]\d{6,14}$/),
    group: "twilio",
    description: "Twilio number in E.164 that sends alert SMS and places escalation calls.",
    example: "+15555550100",
    secret: false,
    required: "feature",
  },
  TWILIO_MESSAGING_SERVICE_SID: {
    schema: nonEmpty,
    group: "twilio",
    description:
      "Optional Twilio Messaging Service to send SMS through instead of the bare number.",
    example: "",
    secret: false,
    required: "optional",
  },

  // --- alerts ----------------------------------------------------------------------------
  ALERT_EMAIL_FROM: {
    schema: nonEmpty,
    group: "alerts",
    description: "From address for lead alerts and system email.",
    example: "alerts@example.com",
    secret: false,
    required: "feature",
  },
  ALERT_SMTP_URL: {
    schema: z.string().regex(/^smtps?:\/\/.+/),
    group: "alerts",
    description: "SMTP server that sends alert email, as smtp(s)://user:password@host:port.",
    example: "",
    secret: true,
    required: "feature",
  },
  ALERT_WHATSAPP_PHONE_NUMBER_ID: {
    schema: nonEmpty,
    group: "alerts",
    description: "Phone number id of the agency's own WhatsApp number that sends alerts.",
    example: "",
    secret: false,
    required: "feature",
  },
  ALERT_WHATSAPP_ACCESS_TOKEN: {
    schema: nonEmpty,
    group: "alerts",
    description: "System-user access token for the agency's alert WhatsApp number.",
    example: "",
    secret: true,
    required: "feature",
  },

  // --- calendly --------------------------------------------------------------------------
  CALENDLY_CLIENT_ID: {
    schema: nonEmpty,
    group: "calendly",
    description: "Calendly OAuth client id.",
    example: "",
    secret: false,
    required: "feature",
  },
  CALENDLY_CLIENT_SECRET: {
    schema: nonEmpty,
    group: "calendly",
    description: "Calendly OAuth client secret.",
    example: "",
    secret: true,
    required: "feature",
  },
  CALENDLY_WEBHOOK_SIGNING_KEY: {
    schema: nonEmpty,
    group: "calendly",
    description: "Signing key for Calendly webhook subscriptions.",
    example: "",
    secret: true,
    required: "feature",
  },

  // --- crm -------------------------------------------------------------------------------
  HUBSPOT_CLIENT_ID: {
    schema: nonEmpty,
    group: "crm",
    description: "HubSpot public app client id.",
    example: "",
    secret: false,
    required: "feature",
  },
  HUBSPOT_CLIENT_SECRET: {
    schema: nonEmpty,
    group: "crm",
    description: "HubSpot public app client secret.",
    example: "",
    secret: true,
    required: "feature",
  },
  GOHIGHLEVEL_CLIENT_ID: {
    schema: nonEmpty,
    group: "crm",
    description: "GoHighLevel marketplace app client id.",
    example: "",
    secret: false,
    required: "feature",
  },
  GOHIGHLEVEL_CLIENT_SECRET: {
    schema: nonEmpty,
    group: "crm",
    description: "GoHighLevel marketplace app client secret.",
    example: "",
    secret: true,
    required: "feature",
  },
  JOBBER_CLIENT_ID: {
    schema: nonEmpty,
    group: "crm",
    description: "Jobber developer app client id.",
    example: "",
    secret: false,
    required: "feature",
  },
  JOBBER_CLIENT_SECRET: {
    schema: nonEmpty,
    group: "crm",
    description: "Jobber developer app client secret.",
    example: "",
    secret: true,
    required: "feature",
  },
  HOUSECALL_PRO_CLIENT_ID: {
    schema: nonEmpty,
    group: "crm",
    description: "Housecall Pro OAuth client id (partner apps; single companies use an API key).",
    example: "",
    secret: false,
    required: "feature",
  },
  HOUSECALL_PRO_CLIENT_SECRET: {
    schema: nonEmpty,
    group: "crm",
    description: "Housecall Pro OAuth client secret.",
    example: "",
    secret: true,
    required: "feature",
  },
  SERVICETITAN_APP_KEY: {
    schema: nonEmpty,
    group: "crm",
    description:
      "ServiceTitan application key. Each business adds its own tenant id, client id and secret in the admin panel.",
    example: "",
    secret: true,
    required: "feature",
  },
  SERVICETITAN_ENVIRONMENT: {
    schema: z.enum(["integration", "production"]),
    group: "crm",
    description: "ServiceTitan API environment.",
    example: "integration",
    secret: false,
    required: "optional",
    default: "integration",
  },

  // --- observability ---------------------------------------------------------------------
  SENTRY_DSN: {
    schema: url,
    group: "observability",
    description: "Sentry DSN for server-side errors.",
    example: "",
    secret: false,
    required: "feature",
  },
  NEXT_PUBLIC_SENTRY_DSN: {
    schema: url,
    group: "observability",
    description: "Sentry DSN for browser errors (usually the same project).",
    example: "",
    secret: false,
    required: "feature",
  },
  SENTRY_AUTH_TOKEN: {
    schema: nonEmpty,
    group: "observability",
    description: "Sentry auth token; uploads source maps during the Vercel build.",
    example: "",
    secret: true,
    required: "optional",
  },
  SENTRY_ORG: {
    schema: nonEmpty,
    group: "observability",
    description: "Sentry organization slug.",
    example: "",
    secret: false,
    required: "optional",
  },
  SENTRY_PROJECT: {
    schema: nonEmpty,
    group: "observability",
    description: "Sentry project slug.",
    example: "",
    secret: false,
    required: "optional",
  },
} as const satisfies Record<string, EnvVarSpec>;

export type EnvName = keyof typeof ENV_SPEC;

export const ENV_NAMES = Object.keys(ENV_SPEC) as EnvName[];
