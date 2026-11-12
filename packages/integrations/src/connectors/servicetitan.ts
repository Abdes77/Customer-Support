import { z } from "zod";

import {
  type ConnectorContext,
  type ConnectorError,
  err,
  type ExternalRecord,
  type IntegrationConnector,
  type LeadSyncPayload,
  ok,
  type PushRecovery,
  type Result,
} from "@repo/core";

import { connectorError, joinUrl, segment, vendorJson } from "../http";
import { applyFieldMapping, type MappedFields, mappedText } from "../mapping";
import { leadTitle, reportNote } from "../payload";

/*
 * ServiceTitan (CRM API v2). Checked on 2026-11-12 against the OpenAPI document of
 * ServiceTitan's "CRM" API (`https://developer.servicetitan.io/api/docs/apis/tenant-crm`,
 * what the browser-only Developer Portal loads): every call with `ST-App-Key` and an OAuth
 * client-credentials bearer token from `https://auth.servicetitan.io/connect/token` (scopes
 * `tn.crm.bookings:r` and `tn.crm.bookings:w`); `POST /crm/v2/tenant/{tenant}/
 * booking-provider/{provider}/bookings` (`Crm.V2.CreateBookingRequest`: source, name, summary,
 * isFirstTimeClient and externalId required; address with street, city, state, zip and
 * country all required; contacts of type Phone, Email, Fax or MobilePhone); `PATCH .../
 * bookings/{id}` (`UpdateBookingRequest`: no contacts; an address needs every field incl.
 * unit); `GET .../bookings?externalId=` (finds our booking again). Both request schemas
 * forbid unknown fields. Not in that document, so from integrators' guides: the integration
 * environment's hosts (`auth-integration` / `api-integration.servicetitan.io`).
 *
 * A lead becomes a booking in the call booking screen, where the business's CSRs match it to
 * a customer and book the job; `externalId` is our reference for the lead
 * (`hsrb-lead-<id>`), which is how a push whose answer was lost is found again instead of
 * creating a second booking. Updates change the same booking.
 */

const VENDOR = "ServiceTitan";

export interface ServiceTitanApp {
  /** Our application's key (`SERVICETITAN_APP_KEY`). */
  readonly appKey: string;
  readonly environment: "integration" | "production";
}

export function serviceTitanHosts(environment: ServiceTitanApp["environment"]): {
  readonly auth: string;
  readonly api: string;
} {
  return environment === "production"
    ? { auth: "https://auth.servicetitan.io", api: "https://api.servicetitan.io" }
    : {
        auth: "https://auth-integration.servicetitan.io",
        api: "https://api-integration.servicetitan.io",
      };
}

export const ServiceTitanCredentials = z.object({
  kind: z.literal("client_credentials"),
  tenantId: z.string().regex(/^\d{1,20}$/, "The tenant id is a number."),
  clientId: z.string().min(1).max(200),
  clientSecret: z.string().min(1).max(500),
  /** The current access token and its expiry, refreshed by the framework. */
  accessToken: z.string().min(1).nullable().default(null),
  expiresAt: z.string().nullable().default(null),
});
export type ServiceTitanCredentials = z.infer<typeof ServiceTitanCredentials>;

export const ServiceTitanConfig = z.object({
  /** The booking provider (tag) the tenant created for us; required to push. */
  bookingProviderId: z
    .string()
    .regex(/^\d{1,20}$/)
    .nullable()
    .default(null),
  campaignId: z.number().int().positive().nullable().default(null),
  businessUnitId: z.number().int().positive().nullable().default(null),
  jobTypeId: z.number().int().positive().nullable().default(null),
});
export type ServiceTitanConfig = z.infer<typeof ServiceTitanConfig>;

type Context = ConnectorContext<ServiceTitanCredentials, ServiceTitanConfig>;

const TokenAnswer = z.object({
  access_token: z.string().min(1),
  expires_in: z.coerce.number().int().positive().default(900),
});
const BookingAnswer = z.object({ id: z.coerce.string() }).passthrough();
const ListAnswer = z.object({ data: z.array(z.unknown()) }).passthrough();
const BookingList = z
  .object({ data: z.array(z.object({ id: z.coerce.string() }).passthrough()) })
  .passthrough();

/** Our reference on a ServiceTitan booking: one booking per lead, found again by it. */
export function serviceTitanReference(payload: LeadSyncPayload): string {
  return `hsrb-lead-${payload.lead.id}`;
}

const CUSTOMER_TYPES = new Set(["Residential", "Commercial"]);

/**
 * The booking body from the mapped fields and the payload, per ServiceTitan's CRM v2 schema
 * (`Crm.V2.CreateBookingRequest` / `UpdateBookingRequest`, both `additionalProperties: false`):
 * an address only when street, city, state and ZIP are all known (the schema requires them;
 * a partial address goes into the summary instead), contacts only on create (the update has
 * no contacts), and the update's address with every field (`AddressPatchModel` requires all).
 */
export function serviceTitanBookingBody(
  fields: MappedFields,
  payload: LeadSyncPayload,
  context: Pick<Context, "config" | "options">,
  mode: "create" | "update",
): Record<string, unknown> {
  const text = (key: string) => mappedText(fields, key);
  const contacts: { type: string; value: string; memo: string }[] = [];
  const phone = text("phone");
  if (phone !== null) contacts.push({ type: "Phone", value: phone, memo: "From the AI assistant" });
  const email = text("email");
  if (email !== null) contacts.push({ type: "Email", value: email, memo: "From the AI assistant" });
  const parts = {
    street: text("address.street"),
    unit: text("address.unit"),
    city: text("address.city"),
    state: text("address.state"),
    zip: text("address.zip"),
  };
  const complete =
    parts.street !== null && parts.city !== null && parts.state !== null && parts.zip !== null;
  const address = complete
    ? {
        street: parts.street,
        ...(parts.unit !== null || mode === "update" ? { unit: parts.unit ?? "" } : {}),
        city: parts.city,
        state: parts.state,
        zip: parts.zip,
        country: text("address.country") ?? "USA",
      }
    : null;
  const partial = [parts.street, parts.unit, parts.city, parts.state, parts.zip].filter(
    (part): part is string => part !== null,
  );
  const report = context.options.includeReport ? reportNote(payload) : null;
  const summary = [
    text("summary") ?? report ?? leadTitle(payload),
    ...(address === null && partial.length > 0 ? [`Address: ${partial.join(", ")}`] : []),
  ].join("\n\n");
  const customerType = text("customerType");
  return {
    source: text("source") ?? context.options.leadSource,
    name: text("name") ?? payload.contact.name ?? "New lead",
    summary: summary.slice(0, 10_000),
    isFirstTimeClient: true,
    customerType:
      customerType !== null && CUSTOMER_TYPES.has(customerType) ? customerType : "Residential",
    ...(mode === "create" ? { externalId: serviceTitanReference(payload) } : {}),
    ...(address === null ? {} : { address }),
    ...(mode === "create" && contacts.length > 0 ? { contacts } : {}),
    ...(context.config.campaignId === null ? {} : { campaignId: context.config.campaignId }),
    ...(context.config.businessUnitId === null
      ? {}
      : { businessUnitId: context.config.businessUnitId }),
    ...(context.config.jobTypeId === null ? {} : { jobTypeId: context.config.jobTypeId }),
  };
}

export function createServiceTitanConnector(
  app: ServiceTitanApp | null,
): IntegrationConnector<ServiceTitanCredentials, ServiceTitanConfig> {
  const hosts = serviceTitanHosts(app?.environment ?? "integration");

  function headers(context: Context): Result<Record<string, string>, ConnectorError> {
    if (app === null) {
      return err(
        connectorError(
          "permission_denied",
          "ServiceTitan is not set up on this deployment (SERVICETITAN_APP_KEY).",
          { retryable: false },
        ),
      );
    }
    if (context.credentials.accessToken === null) {
      return err(
        connectorError("auth_expired", "ServiceTitan has no access token yet.", {
          retryable: true,
        }),
      );
    }
    return ok({
      authorization: `Bearer ${context.credentials.accessToken}`,
      "st-app-key": app.appKey,
    });
  }

  function bookingsUrl(context: Context, bookingId?: string): Result<string, ConnectorError> {
    const provider = context.config.bookingProviderId;
    if (provider === null) {
      return err(
        connectorError(
          "validation",
          "Choose the ServiceTitan booking provider in the connection's settings.",
          { retryable: false },
        ),
      );
    }
    const base = `/crm/v2/tenant/${segment(context.credentials.tenantId)}/booking-provider/${segment(provider)}/bookings`;
    return ok(joinUrl(hosts.api, bookingId === undefined ? base : `${base}/${segment(bookingId)}`));
  }

  /** The booking a lost push made, found by our reference (`GET ...bookings?externalId=`). */
  async function findByReference(
    context: Context,
    headersValue: Record<string, string>,
    url: string,
    reference: string,
  ): Promise<Result<string | null, ConnectorError>> {
    const listed = new URL(url);
    listed.searchParams.set("externalId", reference);
    listed.searchParams.set("pageSize", "1");
    const answer = await vendorJson(
      context.fetch,
      VENDOR,
      { method: "GET", url: listed.toString(), headers: headersValue },
      BookingList,
      context.now,
    );
    if (!answer.ok) return answer;
    const first = answer.value.data.data[0];
    return ok(first === undefined ? null : first.id);
  }

  async function write(
    context: Context,
    payload: LeadSyncPayload,
    bookingId: string | null,
    record: ExternalRecord | undefined,
    recovery: PushRecovery | undefined,
  ): Promise<Result<ExternalRecord, ConnectorError>> {
    const auth = headers(context);
    if (!auth.ok) return auth;
    const url = bookingsUrl(context, bookingId ?? undefined);
    if (!url.ok) return url;
    const { fields } = applyFieldMapping(payload, context.fieldMapping, context.options);
    if (bookingId === null && recovery !== undefined) {
      const found = await findByReference(
        context,
        auth.value,
        url.value,
        serviceTitanReference(payload),
      );
      if (!found.ok) return found;
      if (found.value !== null) {
        return ok({ externalId: found.value, externalUrl: null, state: {} });
      }
    }
    const answer = await vendorJson(
      context.fetch,
      VENDOR,
      {
        method: bookingId === null ? "POST" : "PATCH",
        url: url.value,
        headers: auth.value,
        json: serviceTitanBookingBody(
          fields,
          payload,
          context,
          bookingId === null ? "create" : "update",
        ),
      },
      BookingAnswer,
      context.now,
    );
    if (!answer.ok) return answer;
    return ok({
      externalId: answer.value.data.id,
      externalUrl: record?.externalUrl ?? null,
      state: { ...record?.state },
    });
  }

  return {
    id: "servicetitan",
    displayName: "ServiceTitan",
    auth: {
      type: "api_key",
      fields: [
        { key: "tenantId", label: "Tenant id", secret: false },
        { key: "clientId", label: "Client id", secret: false },
        { key: "clientSecret", label: "Client secret", secret: true },
      ],
    },
    credentialsSchema: ServiceTitanCredentials,
    configSchema: ServiceTitanConfig,
    defaultFieldMapping: [
      { source: "contact.name", target: "name" },
      { source: "contact.phone", target: "phone", transform: "phone_e164" },
      { source: "contact.email", target: "email" },
      { source: "contact.address", target: "address.street" },
      { source: "contact.postalCode", target: "address.zip" },
    ],

    async testConnection(context) {
      const auth = headers(context);
      if (!auth.ok) return auth;
      const url = bookingsUrl(context);
      if (!url.ok) {
        // Without a booking provider the token itself proves the credentials.
        return ok({ accountLabel: `ServiceTitan tenant ${context.credentials.tenantId}` });
      }
      const listed = new URL(url.value);
      listed.searchParams.set("pageSize", "1");
      const answer = await vendorJson(
        context.fetch,
        VENDOR,
        { method: "GET", url: listed.toString(), headers: auth.value },
        ListAnswer,
        context.now,
      );
      if (!answer.ok) return answer;
      return ok({ accountLabel: `ServiceTitan tenant ${context.credentials.tenantId}` });
    },

    pushLead: (context, payload, options) =>
      write(context, payload, null, undefined, options.recovery),

    updateLead: (context, externalId, payload, options) =>
      write(context, payload, externalId, options.record, undefined),

    credentialsExpireSoon(credentials, now) {
      if (credentials.accessToken === null || credentials.expiresAt === null) return true;
      const expires = Date.parse(credentials.expiresAt);
      return Number.isNaN(expires) || expires - now.getTime() <= 120_000;
    },

    async refreshCredentials(context) {
      const answer = await vendorJson(
        context.fetch,
        `${VENDOR} sign-in`,
        {
          method: "POST",
          url: joinUrl(hosts.auth, "/connect/token"),
          form: {
            grant_type: "client_credentials",
            client_id: context.credentials.clientId,
            client_secret: context.credentials.clientSecret,
          },
        },
        TokenAnswer,
        context.now,
      );
      if (!answer.ok) {
        if (answer.error.code === "validation" || answer.error.code === "auth_expired") {
          return err(
            connectorError(
              "auth_expired",
              "ServiceTitan refused the client id and secret. Check them and connect again.",
              { retryable: false },
            ),
          );
        }
        return answer;
      }
      return ok({
        ...context.credentials,
        accessToken: answer.value.data.access_token,
        expiresAt: new Date(
          context.now().getTime() + answer.value.data.expires_in * 1000,
        ).toISOString(),
      });
    },
  };
}
