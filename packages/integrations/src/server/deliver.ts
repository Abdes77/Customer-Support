import {
  type ConnectorContext,
  type ConnectorError,
  type ConnectorSyncOptions,
  type ExternalRecord,
  type IntegrationConnectionId,
  INTEGRATION_IDS,
  type IntegrationId,
  type LeadId,
  type LeadSyncPayload,
  type PushRecovery,
  type Result,
} from "@repo/core";
import {
  and,
  type BusinessContext,
  type BusinessTenant,
  eq,
  inArray,
  integrationConnections,
  integrationEvents,
  integrationRecords,
  ne,
  sql,
} from "@repo/db";
import type { AppSettings } from "@repo/settings";
import { loadSettings } from "@repo/settings/server";

import { type AnyConnector, createConnectorRegistry } from "../connectors/registry";
import { applyFieldMapping, effectiveMapping, fromSettingMapping } from "../mapping";
import { payloadFingerprint, reportNote, transcriptNote } from "../payload";
import { clockOf, type CrmProvider, type IntegrationDeps, isCrmProvider } from "./deps";
import { loadLeadSyncPayload } from "./payload";
import { findTarget, parseTargetAccount, readTargetSecret } from "./targets";

/*
 * One attempt of one delivery: a row of `integration_events` (the journal) to a CRM
 * connection or a webhook target. The rules, each with a test:
 *
 * - The journal is checked first: a delivery that succeeded, was skipped or failed for good
 *   is never sent again, however often its job runs.
 * - An attempt claims the row (`locked_until`) in its own transaction, so a second runner
 *   (the sweeper, a duplicate event) leaves it alone while the first is busy.
 * - For a CRM, the vendor call happens while the lead's `integration_records` row is locked,
 *   and the external id it returns is stored in the same transaction: two deliveries for one
 *   lead never both create a record, and the second one updates what the first created.
 * - The outcome (success, a retry time, a final failure) is written only after the call
 *   answered; errors shown to the admin panel are the connector's safe messages.
 * - One failing target never blocks another: each delivery is its own job run.
 */

/** Pauses after failed attempts 1, 2, 3...; the last one is reused. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 4 * 60 * 60_000];
/** Attempts of a delivery before it fails for good. */
export const MAX_ATTEMPTS = 6;
/** How long an attempt holds its claim on the row. */
const CLAIM_MS = 3 * 60_000;

export type DeliveryOutcome =
  | { readonly status: "succeeded" | "skipped" | "failed" }
  | { readonly status: "retry"; readonly waitMs: number };

/** The pause after a failed attempt, honouring a vendor's Retry-After. */
export function retryDelayMs(attempt: number, retryAfterSeconds: number | null): number {
  const base = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length) - 1] ?? 60_000;
  return retryAfterSeconds === null ? base : Math.max(base, retryAfterSeconds * 1000);
}

export function syncOptions(values: AppSettings, provider: IntegrationId): ConnectorSyncOptions {
  return {
    leadSource: values["integrations.lead_source"],
    tags: values["integrations.tags"],
    includeReport: values["integrations.include_report"],
    includeTranscript:
      provider === "webhook"
        ? values["integrations.webhook_include_transcript"]
        : values["integrations.include_transcript"],
    duplicates: values["integrations.duplicates"],
  };
}

export function fieldMappingFor(
  values: AppSettings,
  provider: IntegrationId,
  connector: AnyConnector,
) {
  if (!isCrmProvider(provider)) return connector.defaultFieldMapping;
  return effectiveMapping(
    fromSettingMapping(values[`integrations.field_mapping.${provider}`]),
    connector.defaultFieldMapping,
  );
}

/** What a CRM would receive, for the "nothing changed" check. */
function fingerprintOf(
  payload: LeadSyncPayload,
  context: Pick<ConnectorContext<unknown, unknown>, "fieldMapping" | "options">,
): string {
  return payloadFingerprint({
    fields: applyFieldMapping(payload, context.fieldMapping, context.options).fields,
    report: context.options.includeReport ? reportNote(payload) : null,
    transcript: context.options.includeTranscript ? transcriptNote(payload) : null,
    booking: payload.booking ?? null,
    status: payload.lead.status,
    routing: payload.lead.routing,
    score: Math.round(payload.lead.score),
    options: { tags: context.options.tags, source: context.options.leadSource },
  });
}

export function connectorsOf(deps: IntegrationDeps): Readonly<Record<IntegrationId, AnyConnector>> {
  const built = createConnectorRegistry(deps.apps);
  return { ...built, ...deps.connectors };
}

function isIntegrationId(value: string): value is IntegrationId {
  return (INTEGRATION_IDS as readonly string[]).includes(value);
}

interface Claim {
  readonly attempt: number;
  readonly eventType: string;
  readonly leadId: LeadId | null;
  readonly idempotencyKey: string;
  readonly connection: {
    readonly id: IntegrationConnectionId;
    readonly provider: IntegrationId;
    readonly status: string;
    readonly externalAccountId: string | null;
    readonly config: Record<string, unknown>;
  };
}

type ClaimResult = Claim | DeliveryOutcome;

/** Reads the delivery and claims it for this attempt, or says why there is nothing to do. */
async function claim(ctx: BusinessContext, deliveryId: string, now: Date): Promise<ClaimResult> {
  const [row] = await ctx.tx
    .select({
      status: integrationEvents.status,
      attempts: integrationEvents.attempts,
      lockedUntil: integrationEvents.lockedUntil,
      eventType: integrationEvents.eventType,
      leadId: integrationEvents.leadId,
      idempotencyKey: integrationEvents.idempotencyKey,
      connectionId: integrationEvents.integrationConnectionId,
    })
    .from(integrationEvents)
    .where(eq(integrationEvents.id, deliveryId))
    .for("update")
    .limit(1);
  if (row === undefined) return { status: "failed" };
  if (row.status !== "pending") {
    return {
      status:
        row.status === "succeeded" ? "succeeded" : row.status === "skipped" ? "skipped" : "failed",
    };
  }
  if (row.lockedUntil !== null && row.lockedUntil.getTime() > now.getTime()) {
    return { status: "retry", waitMs: row.lockedUntil.getTime() - now.getTime() + 1000 };
  }
  const [connection] = await ctx.tx
    .select({
      id: integrationConnections.id,
      provider: integrationConnections.provider,
      status: integrationConnections.status,
      externalAccountId: integrationConnections.externalAccountId,
      config: integrationConnections.config,
    })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, row.connectionId))
    .limit(1);
  if (connection === undefined || !isIntegrationId(connection.provider)) {
    await finish(ctx, deliveryId, now, {
      status: "skipped",
      errorCode: "not_found",
      errorMessage: "The connection no longer exists.",
    });
    return { status: "skipped" };
  }
  await ctx.tx
    .update(integrationEvents)
    .set({
      attempts: row.attempts + 1,
      lockedUntil: new Date(now.getTime() + CLAIM_MS),
    })
    .where(eq(integrationEvents.id, deliveryId));
  return {
    attempt: row.attempts + 1,
    eventType: row.eventType,
    leadId: row.leadId,
    idempotencyKey: row.idempotencyKey,
    connection: { ...connection, provider: connection.provider },
  };
}

async function finish(
  ctx: BusinessContext,
  deliveryId: string,
  now: Date,
  outcome: {
    readonly status: "succeeded" | "skipped" | "failed" | "pending";
    readonly errorCode?: string | null;
    readonly errorMessage?: string | null;
    readonly retryable?: boolean | null;
    readonly externalId?: string | null;
    readonly externalUrl?: string | null;
    readonly nextAttemptAt?: Date | null;
    readonly durationMs?: number | null;
    readonly response?: Record<string, unknown>;
  },
): Promise<void> {
  await ctx.tx
    .update(integrationEvents)
    .set({
      status: outcome.status,
      errorCode: outcome.errorCode ?? null,
      errorMessage: outcome.errorMessage ?? null,
      retryable: outcome.retryable ?? null,
      ...(outcome.externalId === undefined ? {} : { externalId: outcome.externalId }),
      ...(outcome.externalUrl === undefined ? {} : { externalUrl: outcome.externalUrl }),
      ...(outcome.durationMs === undefined ? {} : { durationMs: outcome.durationMs }),
      ...(outcome.response === undefined ? {} : { response: outcome.response }),
      nextAttemptAt: outcome.nextAttemptAt ?? null,
      lockedUntil: null,
      completedAt: outcome.status === "pending" ? null : now,
    })
    .where(eq(integrationEvents.id, deliveryId));
}

export const RECONNECT_MESSAGE = "The CRM refused the stored sign-in: connect it again.";

/** Notes the outcome on the connection, where the admin panel shows it. */
async function noteOnConnection(
  ctx: BusinessContext,
  connection: Claim["connection"],
  now: Date,
  error: ConnectorError | null,
): Promise<void> {
  if (error === null) {
    await ctx.tx
      .update(integrationConnections)
      .set({ lastSyncedAt: now, lastError: null, lastErrorAt: null })
      .where(eq(integrationConnections.id, connection.id));
    return;
  }
  const needsReconnect =
    connection.provider !== "webhook" &&
    (error.code === "auth_expired" || error.code === "permission_denied");
  await ctx.tx
    .update(integrationConnections)
    .set({
      lastError:
        needsReconnect && error.code === "auth_expired" ? RECONNECT_MESSAGE : error.message,
      lastErrorAt: now,
      ...(needsReconnect ? { status: "error" as const } : {}),
    })
    .where(eq(integrationConnections.id, connection.id));
}

interface Prepared {
  readonly connector: AnyConnector;
  readonly context: ConnectorContext<unknown, unknown>;
  readonly payload: LeadSyncPayload;
}

type Prep =
  | { readonly ok: true; readonly value: Prepared }
  | { readonly ok: false; readonly stop: StopReason };

interface StopReason {
  readonly status: "skipped" | "failed";
  readonly code: string;
  readonly message: string;
  /** A connector error to record on the connection too. */
  readonly connectorError?: ConnectorError;
  readonly retryable?: boolean;
}

/**
 * Credentials for a CRM. Read without a lock; when they are about to expire, refreshed under
 * the secret's row lock (read again under it, so two runners never both refresh) and stored.
 * The caller runs this in a transaction of its own that commits before the vendor is called:
 * a vendor that rotates refresh tokens has already invalidated the old one, so the new one
 * must be stored even if the delivery itself then fails.
 */
export async function crmCredentials(
  deps: Pick<IntegrationDeps, "db">,
  ctx: BusinessContext,
  connector: AnyConnector,
  base: Omit<ConnectorContext<unknown, unknown>, "credentials">,
  connectionId: IntegrationConnectionId,
): Promise<Result<unknown, ConnectorError> | null> {
  const unreadable: Result<unknown, ConnectorError> = {
    ok: false,
    error: {
      code: "auth_expired",
      message: "The stored sign-in is not readable: connect the CRM again.",
      retryable: false,
      retryAfterSeconds: null,
    },
  };
  const needsRefresh = (credentials: unknown) =>
    connector.refreshCredentials !== undefined &&
    connector.credentialsExpireSoon?.(credentials, base.now()) === true;

  const stored = await deps.db.secrets.integration.read(ctx, connectionId);
  if (stored === null) return null;
  const first = connector.credentialsSchema.safeParse(stored);
  if (!first.success) return unreadable;
  if (!needsRefresh(first.data)) return { ok: true, value: first.data };

  let outcome: Result<unknown, ConnectorError> | null = null;
  await deps.db.secrets.integration.update(ctx, connectionId, async (current) => {
    if (current === null) return undefined;
    const parsed = connector.credentialsSchema.safeParse(current);
    if (!parsed.success) {
      outcome = unreadable;
      return undefined;
    }
    // Another runner may have refreshed them while this one waited for the lock.
    if (!needsRefresh(parsed.data) || connector.refreshCredentials === undefined) {
      outcome = { ok: true, value: parsed.data };
      return undefined;
    }
    const refreshed = await connector.refreshCredentials({ ...base, credentials: parsed.data });
    outcome = refreshed;
    return refreshed.ok ? refreshed.value : undefined;
  });
  return outcome;
}

/** Error codes that need a person to connect the CRM again; such deliveries wait for it. */
export const RECONNECT_CODES: ReadonlySet<string> = new Set(["auth_expired", "permission_denied"]);

/**
 * After a CRM connection works again (connected anew, or a test passed), the deliveries that
 * failed because it needed reconnecting are queued again (attempts reset). The caller emits
 * `integrations.delivery_requested` for the rows returned once its transaction committed; the
 * sweeper restarts any it could not.
 */
export async function requeueForReconnect(
  ctx: BusinessContext,
  connectionId: IntegrationConnectionId,
  now: Date,
): Promise<{ deliveryId: string; connectionId: IntegrationConnectionId; attempts: number }[]> {
  const rows = await ctx.tx
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
    .where(
      and(
        eq(integrationEvents.integrationConnectionId, connectionId),
        eq(integrationEvents.status, "failed"),
        inArray(integrationEvents.errorCode, [...RECONNECT_CODES]),
        sql`${integrationEvents.eventType} <> 'test_connection'`,
      ),
    )
    .returning({ id: integrationEvents.id });
  return rows.map((row) => ({ deliveryId: row.id, connectionId, attempts: 0 }));
}

async function prepare(
  deps: IntegrationDeps,
  ctx: BusinessContext,
  claimed: Claim,
  values: AppSettings,
): Promise<Prep> {
  const connector = connectorsOf(deps)[claimed.connection.provider];
  const provider = claimed.connection.provider;
  if (claimed.connection.status === "disabled" || claimed.connection.status === "revoked") {
    return {
      ok: false,
      stop: {
        status: "skipped",
        code: "disconnected",
        message: "The connection was switched off.",
      },
    };
  }
  if (claimed.leadId === null) {
    return {
      ok: false,
      stop: { status: "skipped", code: "no_lead", message: "The delivery has no lead." },
    };
  }
  let config: unknown = claimed.connection.config;
  if (provider === "webhook") {
    const account = parseTargetAccount(claimed.connection.externalAccountId);
    const target = account === null ? null : findTarget(values, account.scope, account.name);
    if (!target?.active) {
      return {
        ok: false,
        stop: {
          status: "skipped",
          code: "target_removed",
          message: "The webhook target was removed or switched off.",
        },
      };
    }
    config = { name: target.name, url: target.url, scope: target.scope };
  } else if (claimed.connection.status === "error") {
    return {
      ok: false,
      stop: {
        status: "failed",
        code: "auth_expired",
        message: RECONNECT_MESSAGE,
        retryable: false,
      },
    };
  }
  const parsedConfig = connector.configSchema.safeParse(config);
  if (!parsedConfig.success) {
    return {
      ok: false,
      stop: {
        status: "failed",
        code: "validation",
        message: "The connection's settings are incomplete: open it in the admin panel.",
      },
    };
  }
  const options = syncOptions(values, provider);
  const base = {
    connectionId: claimed.connection.id,
    businessId: ctx.tenant.businessId,
    config: parsedConfig.data,
    fieldMapping: fieldMappingFor(values, provider, connector),
    options,
    fetch: (provider === "webhook" ? deps.poster.fetch : deps.fetch) as unknown as typeof fetch,
    logger: deps.logger.child({
      businessId: ctx.tenant.businessId,
      connectionId: claimed.connection.id,
      provider,
    }),
    now: clockOf(deps),
  };
  let credentials: unknown;
  if (provider === "webhook") {
    const account = parseTargetAccount(claimed.connection.externalAccountId)!;
    credentials = await readTargetSecret(deps, ctx, account, claimed.connection.id);
    if (credentials === null) {
      return {
        ok: false,
        stop: {
          status: "failed",
          code: "no_secret",
          message: "The webhook has no signing secret yet.",
          retryable: true,
        },
      };
    }
  } else {
    const result = await crmCredentials(deps, ctx, connector, base, claimed.connection.id);
    if (result === null) {
      return {
        ok: false,
        stop: {
          status: "failed",
          code: "auth_expired",
          message: RECONNECT_MESSAGE,
          retryable: false,
        },
      };
    }
    if (!result.ok) {
      return {
        ok: false,
        stop: {
          status: "failed",
          code: result.error.code,
          message: result.error.message,
          connectorError: result.error,
          retryable: result.error.retryable,
        },
      };
    }
    credentials = result.value;
  }
  const payload = await loadLeadSyncPayload(ctx, claimed.leadId, {
    appUrl: deps.appUrl,
    trigger: claimed.eventType,
    transcript: options.includeTranscript,
  });
  if (payload === null) {
    return {
      ok: false,
      stop: { status: "skipped", code: "no_lead", message: "The lead no longer exists." },
    };
  }
  return { ok: true, value: { connector, context: { ...base, credentials }, payload } };
}

/**
 * The key in a record's `external_state` that marks a push under way: set (and committed)
 * before the vendor is called while the record has no external id yet, replaced by the
 * connector's state once a push succeeded. A later attempt that finds it knows an earlier push
 * may have reached the vendor without its answer being stored, and asks the connector to look
 * for that record before creating one (`PushRecovery`).
 */
const PUSH_STARTED = "pushStartedAt";
/** How far before the marker a connector looks (clocks of vendor and server differ). */
const RECOVERY_MARGIN_MS = 10 * 60_000;

/**
 * Creates the lead's record row when needed and marks a push as started. Returns when an
 * earlier push started, if one did and never stored its answer. Runs in its own transaction,
 * committed before the vendor call.
 */
async function markPush(
  ctx: BusinessContext,
  connectionId: IntegrationConnectionId,
  leadId: LeadId,
  now: Date,
): Promise<Date | null> {
  await ctx.tx
    .insert(integrationRecords)
    .values({ ...ctx.tenant, integrationConnectionId: connectionId, leadId })
    .onConflictDoNothing();
  const [row] = await ctx.tx
    .select({
      id: integrationRecords.id,
      externalId: integrationRecords.externalId,
      state: integrationRecords.externalState,
    })
    .from(integrationRecords)
    .where(
      and(
        eq(integrationRecords.integrationConnectionId, connectionId),
        eq(integrationRecords.leadId, leadId),
      ),
    )
    .for("update")
    .limit(1);
  if (row?.externalId !== null) return null;
  const earlier = row.state[PUSH_STARTED];
  if (earlier !== undefined) {
    const time = Date.parse(earlier);
    return Number.isNaN(time) ? new Date(0) : new Date(time);
  }
  await ctx.tx
    .update(integrationRecords)
    .set({ externalState: { ...row.state, [PUSH_STARTED]: now.toISOString() } })
    .where(eq(integrationRecords.id, row.id));
  return null;
}

/** Locks the lead's record for a CRM connection (made by `markPush`). */
async function lockRecord(
  ctx: BusinessContext,
  connectionId: IntegrationConnectionId,
  leadId: LeadId,
): Promise<{
  readonly id: string;
  readonly externalId: string | null;
  readonly externalUrl: string | null;
  readonly state: Record<string, string>;
  readonly hash: string | null;
}> {
  await ctx.tx
    .insert(integrationRecords)
    .values({ ...ctx.tenant, integrationConnectionId: connectionId, leadId })
    .onConflictDoNothing();
  const [row] = await ctx.tx
    .select({
      id: integrationRecords.id,
      externalId: integrationRecords.externalId,
      externalUrl: integrationRecords.externalUrl,
      state: integrationRecords.externalState,
      hash: integrationRecords.lastPayloadHash,
    })
    .from(integrationRecords)
    .where(
      and(
        eq(integrationRecords.integrationConnectionId, connectionId),
        eq(integrationRecords.leadId, leadId),
      ),
    )
    .for("update")
    .limit(1);
  return row!;
}

/**
 * Makes one attempt of a delivery. Never throws for a vendor failure; a database failure
 * throws (the job step retries it, and the claim expires).
 */
export async function deliverOnce(
  deps: IntegrationDeps,
  tenant: BusinessTenant,
  deliveryId: string,
): Promise<DeliveryOutcome> {
  const clock = clockOf(deps);
  const scope = () => deps.db.forBusiness(tenant.businessId, { agencyId: tenant.agencyId });
  const claimed = await scope().run((ctx) => claim(ctx, deliveryId, clock()));
  if (!("attempt" in claimed)) return claimed;
  const log = deps.logger.child({
    businessId: tenant.businessId,
    deliveryId,
    connectionId: claimed.connection.id,
    provider: claimed.connection.provider,
  });

  try {
    // Phase 1, committed before any vendor call: the settings, the stop reasons, the
    // credentials (refreshed and stored when they expire), the payload, and for a CRM the
    // record's "push under way" marker.
    const phase = await scope().run(async (ctx) => {
      const settings = await loadSettings(ctx, tenant, { logger: log });
      const prepared = await prepare(deps, ctx, claimed, settings.values);
      const now = clock();
      if (!prepared.ok) {
        const stop = prepared.stop;
        const retry =
          stop.status === "failed" && stop.retryable === true && claimed.attempt < MAX_ATTEMPTS;
        const waitMs = retryDelayMs(
          claimed.attempt,
          stop.connectorError?.retryAfterSeconds ?? null,
        );
        await finish(ctx, deliveryId, now, {
          status: retry ? "pending" : stop.status,
          errorCode: stop.code,
          errorMessage: stop.message,
          retryable: stop.retryable ?? false,
          nextAttemptAt: retry ? new Date(now.getTime() + waitMs) : null,
        });
        if (stop.connectorError !== undefined) {
          await noteOnConnection(ctx, claimed.connection, now, stop.connectorError);
        }
        log.info("integrations.delivery_stopped", { code: stop.code, retry });
        const outcome: DeliveryOutcome = retry
          ? { status: "retry", waitMs }
          : { status: stop.status };
        return { kind: "stop" as const, outcome };
      }
      const earlierPush = isCrmProvider(claimed.connection.provider)
        ? await markPush(ctx, claimed.connection.id, claimed.leadId!, now)
        : null;
      return {
        kind: "go" as const,
        prepared: prepared.value,
        updateOnChange: settings.values["integrations.update_on_change"],
        earlierPush,
      };
    });
    if (phase.kind === "stop") return phase.outcome;

    // Phase 2: the vendor call, holding the lead's record lock for a CRM, and its outcome.
    return await scope().run(async (ctx) => {
      const now = clock();
      const { connector, context, payload } = phase.prepared;
      const isCrm = isCrmProvider(claimed.connection.provider);
      const record = isCrm ? await lockRecord(ctx, claimed.connection.id, claimed.leadId!) : null;
      const fingerprint = fingerprintOf(payload, context);
      const operation = record?.externalId == null ? "push" : "update";
      if (record !== null && record.externalId !== null) {
        if (!phase.updateOnChange) {
          await finish(ctx, deliveryId, now, {
            status: "skipped",
            errorCode: "updates_off",
            errorMessage: "Updates are switched off in the settings.",
            externalId: record.externalId,
            externalUrl: record.externalUrl,
          });
          return { status: "skipped" };
        }
        if (record.hash === fingerprint) {
          await finish(ctx, deliveryId, now, {
            status: "skipped",
            errorCode: "unchanged",
            errorMessage: "Nothing the CRM shows has changed since the last update.",
            externalId: record.externalId,
            externalUrl: record.externalUrl,
          });
          return { status: "skipped" };
        }
      }

      const started = performance.now();
      let result: Result<ExternalRecord, ConnectorError>;
      if (record?.externalId == null) {
        const recovery: PushRecovery | undefined =
          record === null || phase.earlierPush === null
            ? undefined
            : {
                since: new Date(phase.earlierPush.getTime() - RECOVERY_MARGIN_MS),
                isKnownRecord: async (externalId) => {
                  const [known] = await ctx.tx
                    .select({ id: integrationRecords.id })
                    .from(integrationRecords)
                    .where(
                      and(
                        eq(integrationRecords.integrationConnectionId, claimed.connection.id),
                        eq(integrationRecords.externalId, externalId),
                        ne(integrationRecords.id, record.id),
                      ),
                    )
                    .limit(1);
                  return known !== undefined;
                },
              };
        if (recovery !== undefined) {
          log.info("integrations.push_recovery", { attempt: claimed.attempt });
        }
        result = await connector.pushLead(context, payload, {
          idempotencyKey: claimed.idempotencyKey,
          ...(recovery === undefined ? {} : { recovery }),
        });
      } else {
        result = await connector.updateLead(context, record.externalId, payload, {
          idempotencyKey: claimed.idempotencyKey,
          record: {
            externalId: record.externalId,
            externalUrl: record.externalUrl,
            state: record.state,
          },
        });
      }
      const durationMs = Math.round(performance.now() - started);
      const after = clock();
      if (result.ok) {
        if (record !== null) {
          await ctx.tx
            .update(integrationRecords)
            .set({
              externalId: result.value.externalId,
              externalUrl: result.value.externalUrl,
              externalState: { ...result.value.state },
              lastPayloadHash: fingerprint,
              lastPushedAt: after,
            })
            .where(eq(integrationRecords.id, record.id));
        }
        await finish(ctx, deliveryId, after, {
          status: "succeeded",
          externalId: result.value.externalId,
          externalUrl: result.value.externalUrl,
          durationMs,
          response: { operation },
        });
        await noteOnConnection(ctx, claimed.connection, after, null);
        log.info("integrations.delivered", { operation, attempt: claimed.attempt, durationMs });
        return { status: "succeeded" };
      }
      const error = result.error;
      const retry = error.retryable && claimed.attempt < MAX_ATTEMPTS;
      const waitMs = retryDelayMs(claimed.attempt, error.retryAfterSeconds);
      await finish(ctx, deliveryId, after, {
        status: retry ? "pending" : "failed",
        errorCode: error.code,
        errorMessage: error.message,
        retryable: error.retryable,
        nextAttemptAt: retry ? new Date(after.getTime() + waitMs) : null,
        durationMs,
        response: { operation },
      });
      await noteOnConnection(ctx, claimed.connection, after, error);
      log.warn("integrations.delivery_failed", {
        code: error.code,
        attempt: claimed.attempt,
        retry,
      });
      return retry ? { status: "retry", waitMs } : { status: "failed" };
    });
  } catch (error) {
    // Something other than the vendor failed (the database, a bug). Free the claim so the
    // next attempt can run, and let the step retry.
    log.error("integrations.delivery_error", { error });
    const now = clock();
    await scope().run((ctx) =>
      ctx.tx
        .update(integrationEvents)
        .set({
          lockedUntil: null,
          nextAttemptAt: new Date(now.getTime() + retryDelayMs(claimed.attempt, null)),
          errorCode: "internal",
          errorMessage: "The delivery could not be completed; it will be tried again.",
        })
        .where(and(eq(integrationEvents.id, deliveryId), eq(integrationEvents.status, "pending"))),
    );
    if (claimed.attempt >= MAX_ATTEMPTS) {
      await giveUp(deps, tenant, deliveryId, "The delivery failed too many times.");
      return { status: "failed" };
    }
    return { status: "retry", waitMs: retryDelayMs(claimed.attempt, null) };
  }
}

/** Ends a delivery that is still pending as failed (the job gave up on it). */
export async function giveUp(
  deps: IntegrationDeps,
  tenant: BusinessTenant,
  deliveryId: string,
  message: string,
): Promise<void> {
  const now = clockOf(deps)();
  await deps.db.forBusiness(tenant.businessId, { agencyId: tenant.agencyId }).run((ctx) =>
    ctx.tx
      .update(integrationEvents)
      .set({
        status: "failed",
        errorCode: sql`coalesce(${integrationEvents.errorCode}, 'gave_up')`,
        errorMessage: message,
        lockedUntil: null,
        nextAttemptAt: null,
        completedAt: now,
      })
      .where(and(eq(integrationEvents.id, deliveryId), eq(integrationEvents.status, "pending"))),
  );
}

export type { CrmProvider };
