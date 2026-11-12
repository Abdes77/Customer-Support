import { z } from "zod";

import {
  type ConnectorContext,
  type ConnectorError,
  err,
  type ExternalRecord,
  type IntegrationConnector,
  type LeadSyncPayload,
  ok,
  type Result,
} from "@repo/core";

import { joinUrl, segment, vendorJson } from "../http";
import { applyFieldMapping } from "../mapping";
import { leadTitle, reportNote, transcriptNote } from "../payload";
import {
  type OAuthApp,
  OAuthCredentials,
  oauthExpiresSoon,
  TokenCredentials,
  tokenRequest,
} from "./common";

/*
 * GoHighLevel (HighLevel API v2), from HighLevel's marketplace docs read on 2026-11-12:
 * `POST /contacts/upsert` (needs `locationId`; follows the location's duplicate setting;
 * `createNewIfDuplicateAllowed`; tags replace the contact's tags; custom fields as
 * `{ id | key, fieldValue }`; no Idempotency-Key), `PUT /contacts/{id}`,
 * `POST /contacts/{id}/notes` (`body`), scopes `contacts.write`, the `Version` header (the
 * docs list `v3`), a burst limit of 100 requests per 10 seconds per app and location. The
 * base URL `https://services.leadconnectorhq.com`, the OAuth endpoints, `PUT` of a note,
 * `POST /opportunities/` and `GET /locations/{id}` are written from memory
 * (docs/INTEGRATIONS.md).
 *
 * A lead becomes a contact of the connected location (sub-account), upserted by email or
 * phone; the report is a note kept current in place; with a pipeline chosen in the
 * connection's config, an open opportunity is created once.
 */

export const GHL_API = "https://services.leadconnectorhq.com";
export const GHL_AUTHORIZE_URL = "https://marketplace.gohighlevel.com/oauth/chooselocation";
export const GHL_TOKEN_URL = "https://services.leadconnectorhq.com/oauth/token";
export const GHL_API_VERSION = "v3";
export const GHL_SCOPES = [
  "contacts.readonly",
  "contacts.write",
  "opportunities.write",
  "locations.readonly",
] as const;
const VENDOR = "GoHighLevel";

/** Contact fields that go at the top level of the request; anything else is ignored. */
const STANDARD_FIELDS = new Set([
  "firstName",
  "lastName",
  "name",
  "email",
  "phone",
  "address1",
  "city",
  "state",
  "postalCode",
  "country",
  "companyName",
  "website",
  "source",
  "timezone",
]);

export const GoHighLevelCredentials = z.discriminatedUnion("kind", [
  OAuthCredentials,
  TokenCredentials,
]);
export type GoHighLevelCredentials = z.infer<typeof GoHighLevelCredentials>;

export const GoHighLevelConfig = z.object({
  /** The location (sub-account) the token belongs to. */
  locationId: z.string().min(1),
  /** With both set, an open opportunity is created for each new lead. */
  pipelineId: z.string().min(1).nullable().default(null),
  pipelineStageId: z.string().min(1).nullable().default(null),
});
export type GoHighLevelConfig = z.infer<typeof GoHighLevelConfig>;

type Context = ConnectorContext<GoHighLevelCredentials, GoHighLevelConfig>;

const ContactAnswer = z.object({
  contact: z.object({ id: z.string().min(1) }).passthrough(),
});
const NoteAnswer = z.object({ note: z.object({ id: z.string().min(1) }).passthrough() });
const OpportunityAnswer = z.object({
  opportunity: z.object({ id: z.string().min(1) }).passthrough(),
});
const LocationAnswer = z.object({
  location: z.object({ id: z.string().min(1), name: z.string().optional() }).passthrough(),
});

function headers(context: Context): Record<string, string> {
  return {
    authorization: `Bearer ${context.credentials.accessToken}`,
    version: GHL_API_VERSION,
  };
}

/** The contact body from the mapped fields: standard fields, `customField.<key>` and tags. */
export function ghlContactBody(
  context: Pick<Context, "fieldMapping" | "options">,
  payload: LeadSyncPayload,
): Record<string, unknown> {
  const { fields } = applyFieldMapping(payload, context.fieldMapping, context.options);
  const body: Record<string, unknown> = {};
  const customFields: { key?: string; id?: string; fieldValue: string | number | boolean }[] = [];
  for (const [target, value] of Object.entries(fields)) {
    if (STANDARD_FIELDS.has(target)) {
      body[target] = typeof value === "string" ? value : String(value);
    } else if (target.startsWith("customField.") && target.length > "customField.".length) {
      customFields.push({ key: target.slice("customField.".length), fieldValue: value });
    } else if (target.startsWith("customFieldId.") && target.length > "customFieldId.".length) {
      customFields.push({ id: target.slice("customFieldId.".length), fieldValue: value });
    }
  }
  if (customFields.length > 0) body["customFields"] = customFields;
  if (context.options.tags.length > 0) body["tags"] = [...context.options.tags];
  if (body["source"] === undefined) body["source"] = context.options.leadSource;
  return body;
}

function recordUrl(context: Context, contactId: string): string {
  return `https://app.gohighlevel.com/v2/location/${segment(context.config.locationId)}/contacts/detail/${segment(contactId)}`;
}

async function writeNote(
  context: Context,
  contactId: string,
  noteId: string | undefined,
  text: string,
): Promise<Result<string, ConnectorError>> {
  if (noteId !== undefined) {
    const updated = await vendorJson(
      context.fetch,
      VENDOR,
      {
        method: "PUT",
        url: joinUrl(GHL_API, `/contacts/${segment(contactId)}/notes/${segment(noteId)}`),
        headers: headers(context),
        json: { body: text },
      },
      NoteAnswer,
      context.now,
    );
    if (updated.ok || updated.error.code !== "not_found") {
      return updated.ok ? ok(updated.value.data.note.id) : updated;
    }
  }
  const created = await vendorJson(
    context.fetch,
    VENDOR,
    {
      method: "POST",
      url: joinUrl(GHL_API, `/contacts/${segment(contactId)}/notes`),
      headers: headers(context),
      json: { body: text },
    },
    NoteAnswer,
    context.now,
  );
  return created.ok ? ok(created.value.data.note.id) : created;
}

async function sync(
  context: Context,
  payload: LeadSyncPayload,
  previous: ExternalRecord | undefined,
  recovering = false,
): Promise<Result<ExternalRecord, ConnectorError>> {
  const body = ghlContactBody(context, payload);
  let contactId: string;
  if (previous !== undefined) {
    const updated = await vendorJson(
      context.fetch,
      VENDOR,
      {
        method: "PUT",
        url: joinUrl(GHL_API, `/contacts/${segment(previous.externalId)}`),
        headers: headers(context),
        json: body,
      },
      ContactAnswer,
      context.now,
    );
    if (!updated.ok) return updated;
    contactId = updated.value.data.contact.id;
  } else {
    const identified = body["email"] !== undefined || body["phone"] !== undefined;
    const created = await vendorJson(
      context.fetch,
      VENDOR,
      {
        method: "POST",
        // Upsert matches on email and phone; a lead with neither can only be created.
        url: joinUrl(GHL_API, identified ? "/contacts/upsert" : "/contacts/"),
        headers: headers(context),
        json: {
          ...body,
          locationId: context.config.locationId,
          ...(identified
            ? {
                // Recovering an unrecorded push: never create a second contact for it.
                createNewIfDuplicateAllowed:
                  context.options.duplicates === "always_create" && !recovering,
              }
            : {}),
        },
      },
      ContactAnswer,
      context.now,
    );
    if (!created.ok) return created;
    contactId = created.value.data.contact.id;
  }
  const state: Record<string, string> = { ...previous?.state };
  const notes = [
    ["reportNoteId", context.options.includeReport ? reportNote(payload) : null],
    ["transcriptNoteId", context.options.includeTranscript ? transcriptNote(payload) : null],
  ] as const;
  for (const [key, text] of notes) {
    if (text === null) continue;
    const note = await writeNote(context, contactId, state[key], text);
    if (!note.ok) return note;
    state[key] = note.value;
  }
  if (
    state["opportunityId"] === undefined &&
    context.config.pipelineId !== null &&
    context.config.pipelineStageId !== null
  ) {
    const opportunity = await vendorJson(
      context.fetch,
      VENDOR,
      {
        method: "POST",
        url: joinUrl(GHL_API, "/opportunities/"),
        headers: headers(context),
        json: {
          locationId: context.config.locationId,
          pipelineId: context.config.pipelineId,
          pipelineStageId: context.config.pipelineStageId,
          contactId,
          name: leadTitle(payload),
          status: "open",
          source: context.options.leadSource,
        },
      },
      OpportunityAnswer,
      context.now,
    );
    if (!opportunity.ok) return opportunity;
    state["opportunityId"] = opportunity.value.data.opportunity.id;
  }
  return ok({ externalId: contactId, externalUrl: recordUrl(context, contactId), state });
}

export function createGoHighLevelConnector(
  options: { readonly app: OAuthApp | null } = { app: null },
): IntegrationConnector<GoHighLevelCredentials, GoHighLevelConfig> {
  return {
    id: "gohighlevel",
    displayName: "GoHighLevel",
    auth: {
      type: "oauth2",
      authorizeUrl: GHL_AUTHORIZE_URL,
      tokenUrl: GHL_TOKEN_URL,
      scopes: GHL_SCOPES,
    },
    credentialsSchema: GoHighLevelCredentials,
    configSchema: GoHighLevelConfig,
    defaultFieldMapping: [
      { source: "contact.firstName", target: "firstName" },
      { source: "contact.lastName", target: "lastName" },
      { source: "contact.email", target: "email" },
      { source: "contact.phone", target: "phone", transform: "phone_e164" },
      { source: "contact.address", target: "address1" },
      { source: "contact.postalCode", target: "postalCode" },
      { source: "sync.leadSource", target: "source" },
    ],

    async testConnection(context) {
      const answer = await vendorJson(
        context.fetch,
        VENDOR,
        {
          method: "GET",
          url: joinUrl(GHL_API, `/locations/${segment(context.config.locationId)}`),
          headers: headers(context),
        },
        LocationAnswer,
        context.now,
      );
      if (!answer.ok) return answer;
      const location = answer.value.data.location;
      return ok({ accountLabel: location.name ?? `Location ${location.id}` });
    },

    pushLead: (context, payload, options) =>
      sync(context, payload, undefined, options.recovery !== undefined),

    updateLead: (context, externalId, payload, options) =>
      sync(context, payload, {
        externalId,
        externalUrl: options.record?.externalUrl ?? null,
        ...(options.record?.state === undefined ? {} : { state: options.record.state }),
      }),

    credentialsExpireSoon: (credentials, now) => oauthExpiresSoon(credentials, now),

    async refreshCredentials(context) {
      const credentials = context.credentials;
      if (credentials.kind !== "oauth") return ok(credentials);
      if (options.app === null || credentials.refreshToken === null) {
        return err({
          code: "auth_expired",
          message: "GoHighLevel cannot be signed in again automatically. Connect it again.",
          retryable: false,
          retryAfterSeconds: null,
        });
      }
      // HighLevel's refresh tokens are single-use: the new one replaces it (stored by the
      // framework under the connection's lock).
      const refreshed = await tokenRequest(
        context.fetch,
        VENDOR,
        GHL_TOKEN_URL,
        {
          grant_type: "refresh_token",
          client_id: options.app.clientId,
          client_secret: options.app.clientSecret,
          refresh_token: credentials.refreshToken,
          user_type: "Location",
        },
        context.now,
        credentials.refreshToken,
      );
      return refreshed.ok ? ok(refreshed.value.credentials) : refreshed;
    },
  };
}
