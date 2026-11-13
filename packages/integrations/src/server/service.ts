import { randomUUID } from "node:crypto";

import {
  type AgencyId,
  type BusinessId,
  ConfigError,
  type ConnectorContext,
  type IntegrationConnectionId,
  type IntegrationId,
  type LeadId,
  NotFoundError,
  type TraceId,
  type UserId,
  ValidationError,
} from "@repo/core";
import {
  and,
  type BusinessContext,
  desc,
  eq,
  inArray,
  integrationConnections,
  integrationEvents,
  integrationRecords,
  recordSystemAudit,
  requireAgencyRole,
  type UserAccess,
} from "@repo/db";
import { loadSettings } from "@repo/settings/server";

import type { AnyConnector } from "../connectors/registry";
import { tokenRequest } from "../connectors/common";
import {
  applyFieldMapping,
  MAPPING_SOURCES,
  type MappedFields,
  type MappingSource,
} from "../mapping";
import {
  authorizationUrl,
  codeExchangeForm,
  cookieValue,
  CRM_OAUTH_COOKIE,
  type CrmOAuthProvider,
  type CrmOAuthState,
  createOAuthState,
  isOAuthProvider,
  OAUTH_ENDPOINTS,
  OAUTH_STATE_TTL_MS,
  pkcePair,
  readCookieValue,
  verifyOAuthState,
} from "../oauth";
import { UnsafeTargetError } from "../net/safe-post";
import { WebhookCredentials } from "../webhook/connector";
import { generateSigningSecret, secretHint } from "../webhook/sign";
import {
  connectorsOf,
  crmCredentials,
  fieldMappingFor,
  RECONNECT_CODES,
  requeueForReconnect,
  syncOptions,
} from "./deliver";
import {
  clockOf,
  CRM_PROVIDERS,
  type CrmProvider,
  INTEGRATION_ROUTES,
  type IntegrationDeps,
  isCrmProvider,
  publicUrl,
} from "./deps";
import { loadLeadSyncPayload } from "./payload";
import { deliveryEvent } from "./plan";
import {
  AGENCY_SECRET_PURPOSE,
  ensureTargetConnection,
  findTarget,
  targetAccount,
  type TargetScope,
  webhookTargets,
} from "./targets";

/*
 * What the admin panel (C16) calls, after it checked the person's role: connecting a CRM by
 * OAuth or with a key, its settings, a test, disconnecting, the delivery log with retry, a
 * preview of the field mapping, and the webhook targets' status and signing secrets. Nothing
 * returned holds a token or a CRM key. A webhook signing secret is returned only by
 * `revealWebhookSecret` / `rotateWebhookSecret` (the receiver has to be given it; the admin
 * panel offers these to agency admins only) and every reveal is audited.
 */

export interface Tenant {
  readonly agencyId: AgencyId;
  readonly businessId: BusinessId;
}

/** A connection as the admin panel sees it: no token, no key. */
export interface ConnectionView {
  readonly id: IntegrationConnectionId;
  readonly provider: IntegrationId;
  readonly displayName: string | null;
  readonly account: string | null;
  readonly status: string;
  readonly lastError: string | null;
  readonly lastErrorAt: string | null;
  readonly lastSyncedAt: string | null;
  readonly connectedAt: string | null;
  /** The connection's settings (pipeline, booking provider ...). Never a secret. */
  readonly config: Record<string, unknown>;
}

export interface DeliveryView {
  readonly id: string;
  readonly connectionId: IntegrationConnectionId;
  readonly leadId: string | null;
  readonly event: string;
  /** "business:<name>" or "agency:<name>" for a webhook delivery. */
  readonly target: string | null;
  readonly status: string;
  readonly attempts: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly externalId: string | null;
  readonly externalUrl: string | null;
  readonly occurredAt: string;
  readonly nextAttemptAt: string | null;
  readonly completedAt: string | null;
}

export interface WebhookTargetView {
  readonly scope: TargetScope;
  readonly name: string;
  readonly url: string;
  readonly events: readonly string[];
  readonly active: boolean;
  readonly connectionId: IntegrationConnectionId | null;
  readonly lastError: string | null;
  readonly lastErrorAt: string | null;
  readonly lastDeliveredAt: string | null;
  /** "whsec_…a1B2" once a secret exists. */
  readonly secretHint: string | null;
}

export interface ConnectorInfo {
  readonly id: CrmProvider;
  readonly displayName: string;
  /** OAuth is offered when the deployment has the vendor's app. */
  readonly oauth: boolean;
  /** Fields of a key-based connection, when the vendor has one. */
  readonly keyFields: readonly {
    readonly key: string;
    readonly label: string;
    readonly secret: boolean;
  }[];
  readonly defaultFieldMapping: readonly { source: string; target: string; transform?: string }[];
}

export interface OAuthStart {
  readonly authorizationUrl: string;
  readonly cookie: {
    readonly name: string;
    readonly value: string;
    readonly maxAgeSeconds: number;
  };
}

export interface TestResult {
  readonly ok: boolean;
  readonly message: string;
}

export interface IntegrationService {
  catalogue(): ConnectorInfo[];
  mappingSources(): readonly MappingSource[];
  startOAuth(
    tenant: Tenant,
    userId: UserId,
    provider: CrmOAuthProvider,
    options: { readonly returnTo: string },
  ): OAuthStart;
  /** Checks the signed state against the flow's cookie; throws when it does not hold. */
  readState(state: string, cookie: string | null): CrmOAuthState & { readonly verifier: string };
  completeOAuth(
    payload: CrmOAuthState & { readonly verifier: string },
    code: string,
  ): Promise<ConnectionView>;
  /** Connects with a key or client credentials (HubSpot private app, GoHighLevel private
   * integration, Housecall Pro, ServiceTitan). The key is tested before it is stored. */
  connectWithKey(
    tenant: Tenant,
    userId: UserId,
    provider: CrmProvider,
    input: {
      readonly fields: Readonly<Record<string, string>>;
      readonly config?: Record<string, unknown>;
    },
  ): Promise<ConnectionView>;
  list(tenant: Tenant): Promise<ConnectionView[]>;
  updateConfig(
    tenant: Tenant,
    userId: UserId,
    connectionId: IntegrationConnectionId,
    config: Record<string, unknown>,
  ): Promise<ConnectionView>;
  test(tenant: Tenant, userId: UserId, connectionId: IntegrationConnectionId): Promise<TestResult>;
  disconnect(tenant: Tenant, userId: UserId, connectionId: IntegrationConnectionId): Promise<void>;
  deliveries(
    tenant: Tenant,
    filter?: {
      readonly connectionId?: IntegrationConnectionId;
      readonly leadId?: LeadId;
      readonly limit?: number;
    },
  ): Promise<DeliveryView[]>;
  retry(tenant: Tenant, userId: UserId, deliveryId: string): Promise<DeliveryView>;
  previewMapping(
    tenant: Tenant,
    provider: CrmProvider,
    leadId: LeadId,
  ): Promise<{ readonly fields: MappedFields; readonly ignored: readonly string[] }>;
  webhookTargets(tenant: Tenant): Promise<WebhookTargetView[]>;
  /**
   * The signing secrets: for agency admins only. `access` is the signed-in person's access
   * (`requireAccess()`); anyone else gets `TenantAccessError`. Every call is audited.
   */
  revealWebhookSecret(tenant: Tenant, access: UserAccess, name: string): Promise<string>;
  rotateWebhookSecret(tenant: Tenant, access: UserAccess, name: string): Promise<string>;
  testWebhook(
    tenant: Tenant,
    userId: UserId,
    scope: TargetScope,
    name: string,
  ): Promise<TestResult>;
  revealAgencyWebhookSecret(agencyId: AgencyId, access: UserAccess, name: string): Promise<string>;
  rotateAgencyWebhookSecret(agencyId: AgencyId, access: UserAccess, name: string): Promise<string>;
  /** The settings form's check of a webhook address (scheme, port, host, DNS, addresses). */
  checkWebhookUrl(url: string): Promise<TestResult>;
}

const VIEW_COLUMNS = {
  id: integrationConnections.id,
  provider: integrationConnections.provider,
  displayName: integrationConnections.displayName,
  externalAccountId: integrationConnections.externalAccountId,
  status: integrationConnections.status,
  lastError: integrationConnections.lastError,
  lastErrorAt: integrationConnections.lastErrorAt,
  lastSyncedAt: integrationConnections.lastSyncedAt,
  connectedAt: integrationConnections.connectedAt,
  config: integrationConnections.config,
};

type ViewRow = {
  id: IntegrationConnectionId;
  provider: string;
  displayName: string | null;
  externalAccountId: string | null;
  status: string;
  lastError: string | null;
  lastErrorAt: Date | null;
  lastSyncedAt: Date | null;
  connectedAt: Date | null;
  config: Record<string, unknown>;
};

function toView(row: ViewRow): ConnectionView {
  return {
    id: row.id,
    provider: row.provider as IntegrationId,
    displayName: row.displayName,
    account: row.externalAccountId,
    status: row.status,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    connectedAt: row.connectedAt?.toISOString() ?? null,
    config: row.config,
  };
}

const DELIVERY_COLUMNS = {
  id: integrationEvents.id,
  connectionId: integrationEvents.integrationConnectionId,
  leadId: integrationEvents.leadId,
  event: integrationEvents.eventType,
  target: integrationEvents.target,
  status: integrationEvents.status,
  attempts: integrationEvents.attempts,
  errorCode: integrationEvents.errorCode,
  errorMessage: integrationEvents.errorMessage,
  externalId: integrationEvents.externalId,
  externalUrl: integrationEvents.externalUrl,
  occurredAt: integrationEvents.occurredAt,
  nextAttemptAt: integrationEvents.nextAttemptAt,
  completedAt: integrationEvents.completedAt,
};

function toDelivery(row: {
  id: string;
  connectionId: IntegrationConnectionId;
  leadId: string | null;
  event: string;
  target: string | null;
  status: string;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  externalId: string | null;
  externalUrl: string | null;
  occurredAt: Date;
  nextAttemptAt: Date | null;
  completedAt: Date | null;
}): DeliveryView {
  return {
    ...row,
    occurredAt: row.occurredAt.toISOString(),
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

/** Configuration a person may not change: it names the account the credentials belong to. */
const LOCKED_CONFIG = new Set(["hubId", "locationId", "accountName"]);

export function createIntegrationService(deps: IntegrationDeps): IntegrationService {
  const clock = clockOf(deps);
  const connectors = connectorsOf(deps);
  const scope = (tenant: Tenant) =>
    deps.db.forBusiness(tenant.businessId, { agencyId: tenant.agencyId });

  function app(provider: CrmOAuthProvider) {
    return deps.apps[provider];
  }

  function redirectUri(provider: CrmOAuthProvider): string {
    return publicUrl(deps.appUrl, INTEGRATION_ROUTES.oauthCallback(provider));
  }

  function baseContext(
    tenant: Tenant,
    connector: AnyConnector,
    connectionId: IntegrationConnectionId,
    config: unknown,
    fetchImpl: typeof fetch,
  ): Omit<ConnectorContext<unknown, unknown>, "credentials" | "options" | "fieldMapping"> {
    return {
      connectionId,
      businessId: tenant.businessId,
      config,
      fetch: fetchImpl,
      logger: deps.logger.child({ businessId: tenant.businessId, provider: connector.id }),
      now: clock,
    };
  }

  /** The defaults of the settings, for calls outside a delivery (a test). */
  const NEUTRAL_OPTIONS = {
    leadSource: "AI assistant",
    tags: [],
    includeReport: false,
    includeTranscript: false,
    duplicates: "update_existing" as const,
  };

  async function save(
    tenant: Tenant,
    userId: UserId,
    input: {
      readonly provider: CrmProvider;
      readonly account: string;
      readonly displayName: string;
      readonly config: Record<string, unknown>;
      readonly credentials: unknown;
      readonly method: "oauth" | "key";
    },
  ): Promise<ConnectionView> {
    const now = clock();
    const saved = await scope(tenant).run(async (ctx) => {
      const [existing] = await ctx.tx
        .select({
          id: integrationConnections.id,
          config: integrationConnections.config,
          account: integrationConnections.externalAccountId,
        })
        .from(integrationConnections)
        .where(eq(integrationConnections.provider, input.provider))
        .orderBy(desc(integrationConnections.connectedAt))
        .limit(1);
      let id: IntegrationConnectionId;
      let requeued: Awaited<ReturnType<typeof requeueForReconnect>> = [];
      if (existing !== undefined) {
        if (existing.account !== input.account) {
          // Another CRM account: the ids we stored belong to the old one. Leads are pushed
          // to the new account afresh rather than updated by ids it does not have.
          await ctx.tx
            .delete(integrationRecords)
            .where(eq(integrationRecords.integrationConnectionId, existing.id));
        }
        // Connecting again keeps what a person chose (a pipeline, a booking provider).
        const kept: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(existing.config)) {
          if (!LOCKED_CONFIG.has(key)) kept[key] = value;
        }
        await ctx.tx
          .update(integrationConnections)
          .set({
            externalAccountId: input.account,
            displayName: input.displayName,
            status: "active",
            config: { ...kept, ...input.config },
            lastError: null,
            lastErrorAt: null,
            connectedBy: userId,
            connectedAt: now,
          })
          .where(eq(integrationConnections.id, existing.id));
        id = existing.id;
        // Deliveries that waited for this reconnect go out now.
        requeued = await requeueForReconnect(ctx, id, now);
      } else {
        const [row] = await ctx.tx
          .insert(integrationConnections)
          .values({
            ...ctx.tenant,
            provider: input.provider,
            externalAccountId: input.account,
            displayName: input.displayName,
            status: "active",
            config: input.config,
            connectedBy: userId,
            connectedAt: now,
          })
          .returning({ id: integrationConnections.id });
        id = row!.id;
      }
      await deps.db.secrets.integration.write(ctx, id, input.credentials);
      await recordSystemAudit(
        ctx,
        { type: "user", userId },
        {
          action: "integrations.connect",
          targetType: "integration_connection",
          targetId: id,
          summary: `Connected ${connectors[input.provider].displayName} (${input.displayName}) ${input.method === "oauth" ? "by sign-in" : "with a key"}.`,
        },
      );
      const [view] = await ctx.tx
        .select(VIEW_COLUMNS)
        .from(integrationConnections)
        .where(eq(integrationConnections.id, id));
      return { view: toView(view!), requeued };
    });
    await emitRequeued(tenant, saved.requeued, now);
    return saved.view;
  }

  /** Starts the runs of deliveries queued again after a reconnect (the sweeper backs this up). */
  async function emitRequeued(
    tenant: Tenant,
    planned: readonly {
      deliveryId: string;
      connectionId: IntegrationConnectionId;
      attempts: number;
    }[],
    now: Date,
  ): Promise<void> {
    if (planned.length === 0 || deps.events === null) return;
    const input = {
      agencyId: tenant.agencyId,
      businessId: tenant.businessId,
      traceId: randomUUID() as TraceId,
    };
    await deps.events.send(
      planned.map((delivery) => deliveryEvent(input, delivery, `-reconnect-${now.getTime()}`)),
    );
  }

  async function loadConnection(
    ctx: BusinessContext,
    connectionId: IntegrationConnectionId,
  ): Promise<ViewRow & { provider: CrmProvider }> {
    const [row] = await ctx.tx
      .select(VIEW_COLUMNS)
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connectionId))
      .limit(1);
    if (row === undefined || !isCrmProvider(row.provider)) {
      throw new NotFoundError("The CRM connection was not found.");
    }
    return { ...row, provider: row.provider };
  }

  function keyCredentials(
    provider: CrmProvider,
    fields: Readonly<Record<string, string>>,
  ): { credentials: unknown; config: Record<string, unknown> } {
    const value = (key: string) => (fields[key] ?? "").trim();
    switch (provider) {
      case "hubspot":
        return {
          credentials: { kind: "token", accessToken: value("accessToken") },
          config: { hubId: null },
        };
      case "gohighlevel":
        return {
          credentials: { kind: "token", accessToken: value("accessToken") },
          config: { locationId: value("locationId"), pipelineId: null, pipelineStageId: null },
        };
      case "housecall_pro":
        return { credentials: { kind: "api_key", apiKey: value("apiKey") }, config: {} };
      case "servicetitan":
        return {
          credentials: {
            kind: "client_credentials",
            tenantId: value("tenantId"),
            clientId: value("clientId"),
            clientSecret: value("clientSecret"),
            accessToken: null,
            expiresAt: null,
          },
          config: {},
        };
      case "jobber":
        throw new ValidationError("Jobber connects by signing in to Jobber, not with a key.");
    }
  }

  /** Runs the connector's test with fresh credentials; answers the credentials to store. */
  async function tryCredentials(
    tenant: Tenant,
    connector: AnyConnector,
    connectionId: IntegrationConnectionId,
    config: unknown,
    credentials: unknown,
    fetchImpl: typeof fetch,
  ): Promise<
    | { ok: true; credentials: unknown; accountLabel: string }
    | { ok: false; message: string; code: string }
  > {
    const base = {
      ...baseContext(tenant, connector, connectionId, config, fetchImpl),
      options: NEUTRAL_OPTIONS,
      fieldMapping: connector.defaultFieldMapping,
    };
    let current = credentials;
    if (
      connector.refreshCredentials !== undefined &&
      connector.credentialsExpireSoon?.(current, clock()) === true
    ) {
      const refreshed = await connector.refreshCredentials({ ...base, credentials: current });
      if (!refreshed.ok)
        return { ok: false, message: refreshed.error.message, code: refreshed.error.code };
      current = refreshed.value;
    }
    const result = await connector.testConnection({ ...base, credentials: current });
    if (!result.ok) return { ok: false, message: result.error.message, code: result.error.code };
    return { ok: true, credentials: current, accountLabel: result.value.accountLabel };
  }

  async function recordTest(
    ctx: BusinessContext,
    connectionId: IntegrationConnectionId,
    outcome: TestResult & { readonly code?: string },
    target: string | null,
  ): Promise<void> {
    const now = clock();
    await ctx.tx.insert(integrationEvents).values({
      ...ctx.tenant,
      integrationConnectionId: connectionId,
      eventType: "test_connection",
      status: outcome.ok ? "succeeded" : "failed",
      idempotencyKey: `test:${randomUUID()}`,
      attempts: 1,
      target,
      errorCode: outcome.ok ? null : (outcome.code ?? "failed"),
      errorMessage: outcome.ok ? null : outcome.message,
      completedAt: now,
    });
  }

  async function agencySecret(agencyId: AgencyId, name: string, rotate: boolean): Promise<string> {
    return deps.db.forAgency(agencyId).run(async (ctx) => {
      const current = rotate
        ? null
        : await deps.db.secrets.agency.read(ctx, AGENCY_SECRET_PURPOSE, name, WebhookCredentials);
      if (current !== null) return current.signingSecret;
      const signingSecret = generateSigningSecret();
      await deps.db.secrets.agency.write(ctx, AGENCY_SECRET_PURPOSE, name, { signingSecret });
      return signingSecret;
    });
  }

  /**
   * The person's id when they are an admin of the agency; throws otherwise. A signing secret
   * lets its holder forge deliveries to the receiver, so agency members and client users never
   * see one, whatever screen calls this.
   */
  function agencyAdmin(access: UserAccess, agencyId: AgencyId): UserId {
    requireAgencyRole(access, agencyId, ["agency_admin"]);
    return access.userId;
  }

  function validName(name: string): string {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 60) {
      throw new ValidationError("A webhook name is 1 to 60 characters.");
    }
    return trimmed;
  }

  async function businessTargetSecret(
    tenant: Tenant,
    userId: UserId,
    name: string,
    rotate: boolean,
  ): Promise<string> {
    return scope(tenant).run(async (ctx) => {
      const settings = await loadSettings(ctx, tenant, { logger: deps.logger });
      const target = findTarget(settings.values, "business", name);
      if (target === null) throw new NotFoundError("There is no webhook target with that name.");
      const connectionId = await ensureTargetConnection(deps, ctx, target, clock());
      let secret: string | null = null;
      await deps.db.secrets.integration.update(
        ctx,
        connectionId,
        (current) => {
          if (current !== null && !rotate) {
            secret = current.signingSecret;
            return undefined;
          }
          secret = generateSigningSecret();
          return { signingSecret: secret };
        },
        WebhookCredentials,
      );
      await recordSystemAudit(
        ctx,
        { type: "user", userId },
        {
          action: rotate
            ? "integrations.webhook_secret_rotated"
            : "integrations.webhook_secret_revealed",
          targetType: "integration_connection",
          targetId: connectionId,
          summary: `${rotate ? "Rotated" : "Revealed"} the signing secret of webhook "${target.name}".`,
        },
      );
      return secret!;
    });
  }

  async function agencyTargetSecret(
    agencyId: AgencyId,
    userId: UserId,
    name: string,
    rotate: boolean,
  ): Promise<string> {
    const clean = validName(name);
    const secret = await agencySecret(agencyId, clean, rotate);
    await deps.db.forAgency(agencyId).run((ctx) =>
      recordSystemAudit(
        ctx,
        { type: "user", userId },
        {
          action: rotate
            ? "integrations.agency_webhook_secret_rotated"
            : "integrations.agency_webhook_secret_revealed",
          targetType: "agency_webhook",
          targetId: clean,
          summary: `${rotate ? "Rotated" : "Revealed"} the signing secret of agency webhook "${clean}".`,
        },
      ),
    );
    return secret;
  }

  return {
    catalogue() {
      return CRM_PROVIDERS.map((id) => {
        const connector = connectors[id];
        const oauth = isOAuthProvider(id) && app(id) !== null && deps.oauthStateKey !== null;
        const keyFields =
          id === "hubspot"
            ? [{ key: "accessToken", label: "Private app access token", secret: true }]
            : id === "gohighlevel"
              ? [
                  { key: "accessToken", label: "Private integration token", secret: true },
                  { key: "locationId", label: "Location (sub-account) id", secret: false },
                ]
              : connector.auth.type === "api_key"
                ? connector.auth.fields
                : [];
        return {
          id,
          displayName: connector.displayName,
          oauth,
          keyFields,
          defaultFieldMapping: connector.defaultFieldMapping,
        };
      });
    },

    mappingSources: () => MAPPING_SOURCES,

    startOAuth(tenant, userId, provider, options) {
      const oauthApp = app(provider);
      if (oauthApp === null || deps.oauthStateKey === null) {
        throw new ConfigError(
          `${connectors[provider].displayName} sign-in is not configured on this deployment.`,
        );
      }
      const { verifier, challenge } = pkcePair();
      const { state, nonce } = createOAuthState(
        deps.oauthStateKey,
        { p: provider, a: tenant.agencyId, b: tenant.businessId, u: userId, r: options.returnTo },
        clock(),
      );
      return {
        authorizationUrl: authorizationUrl(provider, {
          app: oauthApp,
          redirectUri: redirectUri(provider),
          state,
          codeChallenge: challenge,
        }),
        cookie: {
          name: CRM_OAUTH_COOKIE,
          value: cookieValue(nonce, verifier),
          maxAgeSeconds: OAUTH_STATE_TTL_MS / 1000,
        },
      };
    },

    readState(state, cookie) {
      if (deps.oauthStateKey === null) throw new ConfigError("OAuth is not configured.");
      const parsed = readCookieValue(cookie);
      const check = verifyOAuthState(deps.oauthStateKey, state, parsed?.nonce ?? null, clock());
      if (!check.ok || parsed === null) {
        throw new ValidationError("The sign-in could not be verified. Start again.", {
          details: { reason: check.ok ? "cookie" : check.reason },
        });
      }
      return { ...check.payload, verifier: parsed.verifier };
    },

    async completeOAuth(payload, code) {
      const provider = payload.p;
      const oauthApp = app(provider);
      if (oauthApp === null)
        throw new ConfigError(`${provider} is not configured on this deployment.`);
      const tenant = { agencyId: payload.a as AgencyId, businessId: payload.b as BusinessId };
      const userId = payload.u as UserId;
      const grant = await tokenRequest(
        deps.fetch,
        connectors[provider].displayName,
        OAUTH_ENDPOINTS[provider].token,
        codeExchangeForm(provider, {
          app: oauthApp,
          code,
          redirectUri: redirectUri(provider),
          codeVerifier: payload.verifier,
        }),
        clock,
        null,
      );
      if (!grant.ok) throw new ValidationError(grant.error.message);
      const raw = grant.value.raw as Record<string, unknown>;
      let config: Record<string, unknown>;
      let account: string;
      if (provider === "hubspot") {
        const hubRaw = raw["hub_id"];
        const hubId =
          typeof hubRaw === "number" || typeof hubRaw === "string" ? String(hubRaw) : null;
        config = { hubId };
        account = hubId ?? "HubSpot";
      } else if (provider === "gohighlevel") {
        const locationId = typeof raw["locationId"] === "string" ? raw["locationId"] : null;
        if (locationId === null) {
          throw new ValidationError(
            "Choose one sub-account (location) when connecting GoHighLevel.",
          );
        }
        config = { locationId, pipelineId: null, pipelineStageId: null };
        account = locationId;
      } else {
        config = { accountName: null };
        account = "Jobber";
      }
      const connector = connectors[provider];
      const tried = await tryCredentials(
        tenant,
        connector,
        randomUUID() as IntegrationConnectionId,
        connector.configSchema.parse(config),
        grant.value.credentials,
        deps.fetch as unknown as typeof fetch,
      );
      if (!tried.ok) throw new ValidationError(tried.message);
      if (provider === "jobber") config = { accountName: tried.accountLabel };
      return save(tenant, userId, {
        provider,
        account: provider === "jobber" ? tried.accountLabel : account,
        displayName: tried.accountLabel,
        config,
        credentials: tried.credentials,
        method: "oauth",
      });
    },

    async connectWithKey(tenant, userId, provider, input) {
      const connector = connectors[provider];
      const built = keyCredentials(provider, input.fields);
      const credentials = connector.credentialsSchema.safeParse(built.credentials);
      if (!credentials.success) {
        throw new ValidationError("Some of the connection details are missing or not valid.", {
          details: { fields: credentials.error.issues.map((issue) => issue.path.join(".")) },
        });
      }
      const extra: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input.config ?? {})) {
        if (!LOCKED_CONFIG.has(key)) extra[key] = value;
      }
      const config = connector.configSchema.safeParse({ ...built.config, ...extra });
      if (!config.success) throw new ValidationError("The connection's settings are not valid.");
      const tried = await tryCredentials(
        tenant,
        connector,
        randomUUID() as IntegrationConnectionId,
        config.data,
        credentials.data,
        deps.fetch as unknown as typeof fetch,
      );
      if (!tried.ok) {
        throw new ValidationError(
          `${connector.displayName} did not accept the details: ${tried.message}`,
        );
      }
      const stored = { ...(config.data as Record<string, unknown>) };
      if (provider === "hubspot") {
        stored["hubId"] = /(\d+)/.exec(tried.accountLabel)?.[1] ?? null;
      }
      const account =
        provider === "hubspot"
          ? // The portal id, as an OAuth connection stores it, so switching methods keeps records.
            ((stored["hubId"] as string | null) ?? tried.accountLabel)
          : provider === "gohighlevel"
            ? String(stored["locationId"])
            : provider === "servicetitan"
              ? String((credentials.data as { tenantId: string }).tenantId)
              : tried.accountLabel;
      return save(tenant, userId, {
        provider,
        account,
        displayName: tried.accountLabel,
        config: stored,
        credentials: tried.credentials,
        method: "key",
      });
    },

    async list(tenant) {
      return scope(tenant).run(async (ctx) => {
        const rows = await ctx.tx
          .select(VIEW_COLUMNS)
          .from(integrationConnections)
          .where(inArray(integrationConnections.provider, [...CRM_PROVIDERS]))
          .orderBy(desc(integrationConnections.connectedAt));
        return rows.map(toView);
      });
    },

    async updateConfig(tenant, userId, connectionId, config) {
      return scope(tenant).run(async (ctx) => {
        const connection = await loadConnection(ctx, connectionId);
        const connector = connectors[connection.provider];
        const next: Record<string, unknown> = { ...connection.config };
        for (const [key, value] of Object.entries(config)) {
          if (!LOCKED_CONFIG.has(key)) next[key] = value;
        }
        const parsed = connector.configSchema.safeParse(next);
        if (!parsed.success) {
          throw new ValidationError("The connection's settings are not valid.", {
            details: { fields: parsed.error.issues.map((issue) => issue.path.join(".")) },
          });
        }
        await ctx.tx
          .update(integrationConnections)
          .set({ config: parsed.data as Record<string, unknown> })
          .where(eq(integrationConnections.id, connectionId));
        await recordSystemAudit(
          ctx,
          { type: "user", userId },
          {
            action: "integrations.config",
            targetType: "integration_connection",
            targetId: connectionId,
            summary: `Changed the settings of the ${connector.displayName} connection.`,
          },
        );
        const [view] = await ctx.tx
          .select(VIEW_COLUMNS)
          .from(integrationConnections)
          .where(eq(integrationConnections.id, connectionId));
        return toView(view!);
      });
    },

    async test(tenant, userId, connectionId) {
      // The credentials first, in a transaction of their own (a refreshed token is stored
      // even if the test then fails), then the vendor call outside any transaction, then the
      // outcome.
      const prepared = await scope(tenant).run(async (ctx) => {
        const connection = await loadConnection(ctx, connectionId);
        const connector = connectors[connection.provider];
        const config = connector.configSchema.safeParse(connection.config);
        if (!config.success) {
          return {
            connection,
            connector,
            failure: {
              ok: false,
              message: "The connection's settings are incomplete.",
              code: "validation",
            },
          } as const;
        }
        const base = {
          ...baseContext(
            tenant,
            connector,
            connectionId,
            config.data,
            deps.fetch as unknown as typeof fetch,
          ),
          options: NEUTRAL_OPTIONS,
          fieldMapping: connector.defaultFieldMapping,
        };
        const credentials = await crmCredentials(deps, ctx, connector, base, connectionId);
        if (credentials === null) {
          return {
            connection,
            connector,
            failure: {
              ok: false,
              message: "The connection has no stored sign-in: connect it again.",
              code: "auth_expired",
            },
          } as const;
        }
        if (!credentials.ok) {
          return {
            connection,
            connector,
            failure: {
              ok: false,
              message: credentials.error.message,
              code: credentials.error.code,
            },
          } as const;
        }
        return { connection, connector, context: { ...base, credentials: credentials.value } };
      });
      const { connection, connector } = prepared;
      let outcome: TestResult & { code?: string };
      if (prepared.context === undefined) {
        outcome = prepared.failure ?? { ok: false, message: "The test did not run." };
      } else {
        const result = await connector.testConnection(prepared.context);
        outcome = result.ok
          ? { ok: true, message: `Connected to ${result.value.accountLabel}.` }
          : { ok: false, message: result.error.message, code: result.error.code };
      }
      const now = clock();
      const requeued = await scope(tenant).run(async (ctx) => {
        await ctx.tx
          .update(integrationConnections)
          .set(
            outcome.ok
              ? { status: "active", lastError: null, lastErrorAt: null }
              : {
                  lastError: outcome.message,
                  lastErrorAt: now,
                  ...(outcome.code !== undefined && RECONNECT_CODES.has(outcome.code)
                    ? { status: "error" as const }
                    : {}),
                },
          )
          .where(eq(integrationConnections.id, connectionId));
        await recordTest(ctx, connectionId, outcome, null);
        await recordSystemAudit(
          ctx,
          { type: "user", userId },
          {
            action: "integrations.test",
            targetType: "integration_connection",
            targetId: connectionId,
            summary: `Tested the ${connector.displayName} connection: ${outcome.ok ? "it works" : "it failed"}.`,
          },
        );
        // A connection that needed reconnecting and works again sends what waited for it.
        return outcome.ok && connection.status === "error"
          ? requeueForReconnect(ctx, connectionId, now)
          : [];
      });
      await emitRequeued(tenant, requeued, now);
      return { ok: outcome.ok, message: outcome.message };
    },

    async disconnect(tenant, userId, connectionId) {
      await scope(tenant).run(async (ctx) => {
        const connection = await loadConnection(ctx, connectionId);
        await ctx.tx
          .update(integrationConnections)
          .set({ status: "disabled" })
          .where(eq(integrationConnections.id, connectionId));
        await deps.db.secrets.integration.remove(ctx, connectionId);
        await recordSystemAudit(
          ctx,
          { type: "user", userId },
          {
            action: "integrations.disconnect",
            targetType: "integration_connection",
            targetId: connectionId,
            summary: `Disconnected ${connectors[connection.provider].displayName}.`,
          },
        );
      });
    },

    async deliveries(tenant, filter = {}) {
      return scope(tenant).run(async (ctx) => {
        const conditions = [];
        if (filter.connectionId !== undefined) {
          conditions.push(eq(integrationEvents.integrationConnectionId, filter.connectionId));
        }
        if (filter.leadId !== undefined)
          conditions.push(eq(integrationEvents.leadId, filter.leadId));
        const rows = await ctx.tx
          .select(DELIVERY_COLUMNS)
          .from(integrationEvents)
          .where(conditions.length === 0 ? undefined : and(...conditions))
          .orderBy(desc(integrationEvents.occurredAt))
          .limit(Math.min(Math.max(filter.limit ?? 50, 1), 200));
        return rows.map(toDelivery);
      });
    },

    async retry(tenant, userId, deliveryId) {
      const now = clock();
      const view = await scope(tenant).run(async (ctx) => {
        const [row] = await ctx.tx
          .select(DELIVERY_COLUMNS)
          .from(integrationEvents)
          .where(eq(integrationEvents.id, deliveryId))
          .for("update")
          .limit(1);
        if (row === undefined || row.event === "test_connection") {
          throw new NotFoundError("The delivery was not found.");
        }
        if (row.status !== "failed") {
          throw new ValidationError("Only a failed delivery can be tried again.");
        }
        await ctx.tx
          .update(integrationEvents)
          .set({
            status: "pending",
            attempts: 0,
            nextAttemptAt: now,
            lockedUntil: null,
            completedAt: null,
            errorCode: null,
            errorMessage: null,
            retryable: null,
          })
          .where(eq(integrationEvents.id, deliveryId));
        await recordSystemAudit(
          ctx,
          { type: "user", userId },
          {
            action: "integrations.retry",
            targetType: "integration_event",
            targetId: deliveryId,
            summary: "Tried a failed CRM or webhook delivery again.",
          },
        );
        const [updated] = await ctx.tx
          .select(DELIVERY_COLUMNS)
          .from(integrationEvents)
          .where(eq(integrationEvents.id, deliveryId));
        return toDelivery(updated!);
      });
      if (deps.events !== null) {
        await deps.events.send([
          deliveryEvent(
            {
              agencyId: tenant.agencyId,
              businessId: tenant.businessId,
              traceId: randomUUID() as TraceId,
            },
            { deliveryId, connectionId: view.connectionId, attempts: 0 },
            `-retry-${now.getTime()}`,
          ),
        ]);
      }
      return view;
    },

    async previewMapping(tenant, provider, leadId) {
      return scope(tenant).run(async (ctx) => {
        const settings = await loadSettings(ctx, tenant, { logger: deps.logger });
        const connector = connectors[provider];
        const options = syncOptions(settings.values, provider);
        const payload = await loadLeadSyncPayload(ctx, leadId, {
          appUrl: deps.appUrl,
          trigger: "preview",
          transcript: false,
        });
        if (payload === null) throw new NotFoundError("The lead was not found.");
        return applyFieldMapping(
          payload,
          fieldMappingFor(settings.values, provider, connector),
          options,
        );
      });
    },

    async webhookTargets(tenant) {
      const views = await scope(tenant).run(async (ctx) => {
        const settings = await loadSettings(ctx, tenant, { logger: deps.logger });
        const targets = webhookTargets(settings.values);
        const rows = await ctx.tx
          .select(VIEW_COLUMNS)
          .from(integrationConnections)
          .where(eq(integrationConnections.provider, "webhook"));
        const byAccount = new Map(rows.map((row) => [row.externalAccountId, row]));
        const result: WebhookTargetView[] = [];
        for (const target of targets) {
          const row = byAccount.get(targetAccount(target.scope, target.name));
          let hint: string | null = null;
          if (row !== undefined && target.scope === "business") {
            const secret = await deps.db.secrets.integration.read(ctx, row.id, WebhookCredentials);
            hint = secret === null ? null : secretHint(secret.signingSecret);
          } else if (target.scope === "agency") {
            const secret = await deps.db.secrets.agency.read(
              ctx,
              AGENCY_SECRET_PURPOSE,
              target.name,
              WebhookCredentials,
            );
            hint = secret === null ? null : secretHint(secret.signingSecret);
          }
          result.push({
            scope: target.scope,
            name: target.name,
            url: target.url,
            events: target.events,
            active: target.active,
            connectionId: row?.id ?? null,
            lastError: row?.lastError ?? null,
            lastErrorAt: row?.lastErrorAt?.toISOString() ?? null,
            lastDeliveredAt: row?.lastSyncedAt?.toISOString() ?? null,
            secretHint: hint,
          });
        }
        return result;
      });
      return views;
    },

    revealWebhookSecret: async (tenant, access, name) =>
      businessTargetSecret(tenant, agencyAdmin(access, tenant.agencyId), name, false),
    rotateWebhookSecret: async (tenant, access, name) =>
      businessTargetSecret(tenant, agencyAdmin(access, tenant.agencyId), name, true),
    revealAgencyWebhookSecret: async (agencyId, access, name) =>
      agencyTargetSecret(agencyId, agencyAdmin(access, agencyId), name, false),
    rotateAgencyWebhookSecret: async (agencyId, access, name) =>
      agencyTargetSecret(agencyId, agencyAdmin(access, agencyId), name, true),

    async testWebhook(tenant, userId, targetScope, name) {
      if (targetScope === "agency") await agencySecret(tenant.agencyId, validName(name), false);
      return scope(tenant).run(async (ctx) => {
        const settings = await loadSettings(ctx, tenant, { logger: deps.logger });
        const target = findTarget(settings.values, targetScope, name);
        if (target === null) throw new NotFoundError("There is no webhook target with that name.");
        const connectionId = await ensureTargetConnection(deps, ctx, target, clock());
        const credentials =
          targetScope === "agency"
            ? await deps.db.secrets.agency.read(
                ctx,
                AGENCY_SECRET_PURPOSE,
                name,
                WebhookCredentials,
              )
            : await deps.db.secrets.integration.read(ctx, connectionId, WebhookCredentials);
        const connector = connectors.webhook;
        const result = await connector.testConnection({
          ...baseContext(
            tenant,
            connector,
            connectionId,
            { name: target.name, url: target.url, scope: target.scope },
            deps.poster.fetch as unknown as typeof fetch,
          ),
          credentials,
          options: NEUTRAL_OPTIONS,
          fieldMapping: [],
        });
        const outcome: TestResult & { code?: string } = result.ok
          ? { ok: true, message: `The address answered.` }
          : { ok: false, message: result.error.message, code: result.error.code };
        await ctx.tx
          .update(integrationConnections)
          .set(
            outcome.ok
              ? { lastError: null, lastErrorAt: null }
              : { lastError: outcome.message, lastErrorAt: clock() },
          )
          .where(eq(integrationConnections.id, connectionId));
        await recordTest(ctx, connectionId, outcome, targetAccount(target.scope, target.name));
        await recordSystemAudit(
          ctx,
          { type: "user", userId },
          {
            action: "integrations.webhook_test",
            targetType: "integration_connection",
            targetId: connectionId,
            summary: `Sent a test to webhook "${target.name}": ${outcome.ok ? "it answered" : "it failed"}.`,
          },
        );
        return { ok: outcome.ok, message: outcome.message };
      });
    },

    async checkWebhookUrl(url) {
      try {
        await deps.poster.check(url);
        return { ok: true, message: "The address can be used." };
      } catch (error) {
        if (error instanceof UnsafeTargetError) return { ok: false, message: error.message };
        throw error;
      }
    },
  };
}
