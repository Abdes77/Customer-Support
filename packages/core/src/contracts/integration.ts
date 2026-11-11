import type { z } from "zod";

import type {
  BusinessId,
  ContactId,
  ConversationId,
  IntegrationConnectionId,
  IsoDateTime,
  LeadId,
} from "../ids";
import type { Logger } from "../logger";
import type { Result } from "../result";
import type { ChannelId } from "./channel";
import type { LeadStatus, RoutingOutcome } from "./lead";

/**
 * Integration connector contract (owner: C14, package `@repo/integrations`).
 *
 * One connector per CRM plus the generic signed webhook. Connectors are stateless: the
 * framework loads the connection, decrypts credentials, applies the field mapping from
 * settings, supplies an idempotency key, retries with backoff and records every attempt in
 * the integration event log.
 */

export const INTEGRATION_IDS = [
  "hubspot",
  "gohighlevel",
  "jobber",
  "housecall_pro",
  "servicetitan",
  "webhook",
] as const;
export type IntegrationId = (typeof INTEGRATION_IDS)[number];

export type ConnectorAuth =
  | {
      readonly type: "oauth2";
      readonly authorizeUrl: string;
      readonly tokenUrl: string;
      readonly scopes: readonly string[];
    }
  | {
      readonly type: "api_key";
      /** Fields the admin panel asks for. `secret` fields are stored encrypted. */
      readonly fields: readonly {
        readonly key: string;
        readonly label: string;
        readonly secret: boolean;
      }[];
    }
  | { readonly type: "none" };

/** The canonical lead payload every connector receives. Field mappings read from it by path. */
export interface LeadSyncPayload {
  readonly lead: {
    readonly id: LeadId;
    readonly status: LeadStatus;
    readonly score: number;
    readonly band: string;
    readonly routing: RoutingOutcome | null;
    /** Criterion key to plain value, for example { timeline: "this_month" }. */
    readonly fields: Readonly<Record<string, unknown>>;
    readonly report: { readonly summary: string; readonly markdown: string } | null;
    readonly createdAt: IsoDateTime;
    readonly updatedAt: IsoDateTime;
  };
  readonly contact: {
    readonly id: ContactId;
    readonly name: string | null;
    readonly phone: string | null;
    readonly email: string | null;
    readonly address: string | null;
  };
  readonly business: { readonly id: BusinessId; readonly name: string };
  readonly conversation: {
    readonly id: ConversationId;
    readonly channel: ChannelId;
    /** Link to the conversation in the admin panel. */
    readonly url: string;
  };
}

/** One row of a field mapping: copy `source` (a dot path into LeadSyncPayload) to `target`. */
export interface FieldMappingEntry {
  readonly source: string;
  /** Field name in the external system. */
  readonly target: string;
  readonly transform?: "string" | "number" | "boolean" | "date" | "phone_e164";
}
export type FieldMapping = readonly FieldMappingEntry[];

export interface ConnectorError {
  readonly code:
    | "auth_expired"
    | "permission_denied"
    | "rate_limited"
    | "validation"
    | "not_found"
    | "unavailable"
    | "unknown";
  /** Safe to show in the admin panel: no secrets, no raw provider payloads. */
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;
}

export interface ConnectorContext<TCredentials, TConfig> {
  readonly connectionId: IntegrationConnectionId;
  readonly businessId: BusinessId;
  /** Decrypted. Never log, never return to a browser. */
  readonly credentials: TCredentials;
  readonly config: TConfig;
  readonly fieldMapping: FieldMapping;
  /** Injected so contract tests can replay recorded fixtures. */
  readonly fetch: typeof fetch;
  readonly logger: Logger;
  readonly now: () => Date;
}

export interface ExternalRecord {
  readonly externalId: string;
  /** Deep link to the record in the external system, when it has one. */
  readonly externalUrl: string | null;
}

export interface IntegrationConnector<TCredentials = unknown, TConfig = unknown> {
  readonly id: IntegrationId;
  readonly displayName: string;
  readonly auth: ConnectorAuth;
  readonly credentialsSchema: z.ZodType<TCredentials>;
  readonly configSchema: z.ZodType<TConfig>;
  /** Sensible mapping used until the business customises it in settings. */
  readonly defaultFieldMapping: FieldMapping;

  /** Cheap authenticated call that proves the connection works. */
  testConnection(
    context: ConnectorContext<TCredentials, TConfig>,
  ): Promise<Result<{ readonly accountLabel: string }, ConnectorError>>;

  /** Creates the lead (and its report) in the external system. Must honour the idempotency key. */
  pushLead(
    context: ConnectorContext<TCredentials, TConfig>,
    payload: LeadSyncPayload,
    options: { readonly idempotencyKey: string },
  ): Promise<Result<ExternalRecord, ConnectorError>>;

  /** Updates a lead that was pushed before. */
  updateLead(
    context: ConnectorContext<TCredentials, TConfig>,
    externalId: string,
    payload: LeadSyncPayload,
    options: { readonly idempotencyKey: string },
  ): Promise<Result<ExternalRecord, ConnectorError>>;

  /** Exchanges a refresh token for new credentials (OAuth connectors only). */
  refreshCredentials?(
    context: ConnectorContext<TCredentials, TConfig>,
  ): Promise<Result<TCredentials, ConnectorError>>;
}
