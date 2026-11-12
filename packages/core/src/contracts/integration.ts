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

/**
 * The canonical lead payload every connector receives. Field mappings read from it by path.
 * Every string that comes from the conversation (names, addresses, lead fields, the report,
 * the transcript) is customer-written: connectors send it as data, encoded the way the
 * vendor's API expects (JSON values, GraphQL variables), never spliced into a query or markup.
 */
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
    /** C14: the event that caused this sync ("lead.qualified", "booking.confirmed", ...). */
    readonly trigger?: string;
  };
  readonly contact: {
    readonly id: ContactId;
    readonly name: string | null;
    readonly phone: string | null;
    readonly email: string | null;
    readonly address: string | null;
    /** C14: `name` split at the last space (a single word is the first name). */
    readonly firstName?: string | null;
    readonly lastName?: string | null;
    /** C14: a five-digit ZIP code found in the address or the service-area answer. */
    readonly postalCode?: string | null;
  };
  readonly business: { readonly id: BusinessId; readonly name: string };
  readonly conversation: {
    readonly id: ConversationId;
    readonly channel: ChannelId;
    /** Link to the conversation in the admin panel. */
    readonly url: string;
  };
  /** C14: the lead's newest booking (C12), when it has one. */
  readonly booking?: {
    readonly id: string;
    readonly status: string;
    readonly startsAt: IsoDateTime | null;
    readonly endsAt: IsoDateTime | null;
    readonly timezone: string | null;
  } | null;
  /**
   * C14: the conversation as plain text, oldest first, only when the settings ask for it
   * (`integrations.include_transcript`, `integrations.webhook_include_transcript`).
   */
  readonly transcript?: string | null;
}

/** C14: what the settings of the business ask of every push (the same for every CRM). */
export interface ConnectorSyncOptions {
  /** `integrations.lead_source`. */
  readonly leadSource: string;
  /** `integrations.tags`. */
  readonly tags: readonly string[];
  /** Add the written report as a note (`integrations.include_report`). */
  readonly includeReport: boolean;
  /** Add the transcript as a note (`integrations.include_transcript`). */
  readonly includeTranscript: boolean;
  /** `integrations.duplicates`: reuse a contact with the same email or phone, or always create. */
  readonly duplicates: "update_existing" | "always_create";
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
  /** C14: the business's integration settings for this push. */
  readonly options: ConnectorSyncOptions;
  /** Injected so contract tests can replay recorded fixtures. */
  readonly fetch: typeof fetch;
  readonly logger: Logger;
  readonly now: () => Date;
}

export interface ExternalRecord {
  readonly externalId: string;
  /** Deep link to the record in the external system, when it has one. */
  readonly externalUrl: string | null;
  /**
   * C14: ids of related records the connector needs later (the contact behind a request, a
   * note it keeps current). Stored with the record and handed back to `updateLead`. Ids only.
   */
  readonly state?: Readonly<Record<string, string>>;
}

/**
 * C14: an earlier push of this lead to this connection started at `since` and its answer was
 * never stored (the vendor may have accepted it and our database write failed, or the process
 * died mid-call). Before creating anything, the connector looks for what that push may have
 * created (by our external reference, the email or the phone) and adopts it. `isKnownRecord`
 * says whether an external id is already stored for another lead of this connection, so a
 * record that belongs to an earlier lead of the same customer is never adopted.
 */
export interface PushRecovery {
  readonly since: Date;
  isKnownRecord(externalId: string): Promise<boolean>;
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
    options: {
      readonly idempotencyKey: string;
      /** C14: set when an earlier push of this lead may have reached the vendor unrecorded. */
      readonly recovery?: PushRecovery;
    },
  ): Promise<Result<ExternalRecord, ConnectorError>>;

  /** Updates a lead that was pushed before. */
  updateLead(
    context: ConnectorContext<TCredentials, TConfig>,
    externalId: string,
    payload: LeadSyncPayload,
    options: {
      readonly idempotencyKey: string;
      /** C14: the record as stored after the last push, with the connector's state. */
      readonly record?: ExternalRecord;
    },
  ): Promise<Result<ExternalRecord, ConnectorError>>;

  /**
   * Exchanges a refresh token (or client credentials) for new credentials. The framework calls
   * it under the connection's secret lock when `credentialsExpireSoon` says so.
   */
  refreshCredentials?(
    context: ConnectorContext<TCredentials, TConfig>,
  ): Promise<Result<TCredentials, ConnectorError>>;

  /** C14: true when the stored credentials must be refreshed before the next call. */
  credentialsExpireSoon?(credentials: TCredentials, now: Date): boolean;
}
