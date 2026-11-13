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

import { joinUrl, segment, vendorJson } from "../http";
import { applyFieldMapping } from "../mapping";
import { reportNote, textToHtml, transcriptNote } from "../payload";
import {
  type OAuthApp,
  OAuthCredentials,
  oauthExpiresSoon,
  stringify,
  TokenCredentials,
  tokenRequest,
} from "./common";

/*
 * HubSpot (CRM API v3), from HubSpot's developer docs read on 2026-11-12: contacts
 * (`/crm/v3/objects/contacts`, create, update by record id, batch upsert by email), notes
 * (`/crm/v3/objects/notes`, `hs_note_body` up to 65,536 characters, association type 202 to a
 * contact), OAuth (`https://app.hubspot.com/oauth/authorize`, tokens at
 * `https://api.hubapi.com/oauth/v3/token`, 30-minute access tokens, `hub_id` in the answer).
 * The search endpoint (`/crm/v3/objects/contacts/search`, five requests a second per account)
 * and the account-info endpoint are written from memory (docs/INTEGRATIONS.md).
 *
 * A lead becomes a contact: the mapped fields are its properties; the report (and, when the
 * settings ask, the transcript) is a note on it, kept current in place rather than added again
 * on every update. Note bodies are rich text in HubSpot, so the text is HTML-escaped.
 */

export const HUBSPOT_API = "https://api.hubapi.com";
export const HUBSPOT_AUTHORIZE_URL = "https://app.hubspot.com/oauth/authorize";
export const HUBSPOT_TOKEN_URL = "https://api.hubapi.com/oauth/v3/token";
export const HUBSPOT_SCOPES = [
  "oauth",
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
] as const;
/** HubSpot-defined association type of a note to a contact. */
const NOTE_TO_CONTACT = 202;
const VENDOR = "HubSpot";

export const HubSpotCredentials = z.discriminatedUnion("kind", [
  OAuthCredentials,
  TokenCredentials,
]);
export type HubSpotCredentials = z.infer<typeof HubSpotCredentials>;

export const HubSpotConfig = z.object({
  /** The HubSpot account (portal) id, for links to records. */
  hubId: z.string().nullable().default(null),
});
export type HubSpotConfig = z.infer<typeof HubSpotConfig>;

type Context = ConnectorContext<HubSpotCredentials, HubSpotConfig>;

const ObjectAnswer = z.object({ id: z.string().min(1) });
const SearchAnswer = z.object({
  total: z.number().optional(),
  results: z.array(z.object({ id: z.string().min(1) })),
});
const AccountAnswer = z.object({ portalId: z.coerce.string() }).passthrough();

function headers(context: Context): Record<string, string> {
  return { authorization: `Bearer ${context.credentials.accessToken}` };
}

function recordUrl(context: Context, contactId: string): string | null {
  return context.config.hubId === null
    ? null
    : `https://app.hubspot.com/contacts/${segment(context.config.hubId)}/record/0-1/${segment(contactId)}`;
}

/** The contact's properties: exactly the mapped fields, as strings. */
function properties(context: Context, payload: LeadSyncPayload): Record<string, string> {
  const { fields } = applyFieldMapping(payload, context.fieldMapping, context.options);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) result[key] = stringify(value);
  return result;
}

async function findExisting(
  context: Context,
  props: Readonly<Record<string, string>>,
): Promise<Result<string | null, ConnectorError>> {
  for (const propertyName of ["email", "phone"] as const) {
    const value = props[propertyName];
    if (value === undefined || value.length === 0) continue;
    const found = await vendorJson(
      context.fetch,
      VENDOR,
      {
        method: "POST",
        url: joinUrl(HUBSPOT_API, "/crm/v3/objects/contacts/search"),
        headers: headers(context),
        json: {
          filterGroups: [{ filters: [{ propertyName, operator: "EQ", value }] }],
          properties: ["email"],
          limit: 1,
        },
      },
      SearchAnswer,
      context.now,
    );
    if (!found.ok) return found;
    const first = found.value.data.results[0];
    if (first !== undefined) return ok(first.id);
  }
  return ok(null);
}

/** HubSpot answers a create of a known email with 409 "Contact already exists. Existing ID: 123". */
function existingIdFrom(error: ConnectorError): string | null {
  return /Existing ID:\s*(\d+)/i.exec(error.message)?.[1] ?? null;
}

async function writeContact(
  context: Context,
  contactId: string | null,
  props: Readonly<Record<string, string>>,
): Promise<Result<string, ConnectorError>> {
  if (contactId !== null) {
    const updated = await vendorJson(
      context.fetch,
      VENDOR,
      {
        method: "PATCH",
        url: joinUrl(HUBSPOT_API, `/crm/v3/objects/contacts/${segment(contactId)}`),
        headers: headers(context),
        json: { properties: props },
      },
      ObjectAnswer,
      context.now,
    );
    return updated.ok ? ok(updated.value.data.id) : updated;
  }
  const created = await vendorJson(
    context.fetch,
    VENDOR,
    {
      method: "POST",
      url: joinUrl(HUBSPOT_API, "/crm/v3/objects/contacts"),
      headers: headers(context),
      json: { properties: props },
    },
    ObjectAnswer,
    context.now,
  );
  if (created.ok) return ok(created.value.data.id);
  const existing = existingIdFrom(created.error);
  // An email HubSpot already has cannot be created twice, whatever the duplicates setting.
  if (existing !== null) return writeContact(context, existing, props);
  return created;
}

/** Creates the note, or replaces the text of the one made before. Returns its id. */
async function writeNote(
  context: Context,
  contactId: string,
  noteId: string | undefined,
  text: string,
): Promise<Result<string, ConnectorError>> {
  const body = { hs_note_body: textToHtml(text) };
  if (noteId !== undefined) {
    const updated = await vendorJson(
      context.fetch,
      VENDOR,
      {
        method: "PATCH",
        url: joinUrl(HUBSPOT_API, `/crm/v3/objects/notes/${segment(noteId)}`),
        headers: headers(context),
        json: { properties: body },
      },
      ObjectAnswer,
      context.now,
    );
    // Someone deleted the note in HubSpot: write a new one.
    if (updated.ok || updated.error.code !== "not_found") {
      return updated.ok ? ok(updated.value.data.id) : updated;
    }
  }
  const created = await vendorJson(
    context.fetch,
    VENDOR,
    {
      method: "POST",
      url: joinUrl(HUBSPOT_API, "/crm/v3/objects/notes"),
      headers: headers(context),
      json: {
        properties: { hs_timestamp: context.now().toISOString(), ...body },
        associations: [
          {
            to: { id: contactId },
            types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: NOTE_TO_CONTACT }],
          },
        ],
      },
    },
    ObjectAnswer,
    context.now,
  );
  return created.ok ? ok(created.value.data.id) : created;
}

async function sync(
  context: Context,
  payload: LeadSyncPayload,
  previous: ExternalRecord | undefined,
  recovery?: PushRecovery,
): Promise<Result<ExternalRecord, ConnectorError>> {
  const props = properties(context, payload);
  let contactId = previous?.externalId ?? null;
  if (
    contactId === null &&
    (context.options.duplicates === "update_existing" || recovery !== undefined)
  ) {
    const found = await findExisting(context, props);
    if (!found.ok) return found;
    contactId = found.value;
    // Recovering with "always create": adopt the contact only when it is not another lead's.
    if (
      contactId !== null &&
      context.options.duplicates === "always_create" &&
      recovery !== undefined &&
      (await recovery.isKnownRecord(contactId))
    ) {
      contactId = null;
    }
  }
  const written = await writeContact(context, contactId, props);
  if (!written.ok) return written;
  const state: Record<string, string> = { ...previous?.state };
  const notes = [
    ["reportNoteId", context.options.includeReport ? reportNote(payload) : null],
    ["transcriptNoteId", context.options.includeTranscript ? transcriptNote(payload) : null],
  ] as const;
  for (const [key, text] of notes) {
    if (text === null) continue;
    const note = await writeNote(context, written.value, state[key], text);
    if (!note.ok) return note;
    state[key] = note.value;
  }
  return ok({ externalId: written.value, externalUrl: recordUrl(context, written.value), state });
}

export function createHubSpotConnector(
  options: { readonly app: OAuthApp | null } = { app: null },
): IntegrationConnector<HubSpotCredentials, HubSpotConfig> {
  return {
    id: "hubspot",
    displayName: "HubSpot",
    auth: {
      type: "oauth2",
      authorizeUrl: HUBSPOT_AUTHORIZE_URL,
      tokenUrl: HUBSPOT_TOKEN_URL,
      scopes: HUBSPOT_SCOPES,
    },
    credentialsSchema: HubSpotCredentials,
    configSchema: HubSpotConfig,
    defaultFieldMapping: [
      { source: "contact.email", target: "email" },
      { source: "contact.firstName", target: "firstname" },
      { source: "contact.lastName", target: "lastname" },
      { source: "contact.phone", target: "phone", transform: "phone_e164" },
      { source: "contact.address", target: "address" },
      { source: "contact.postalCode", target: "zip" },
    ],

    async testConnection(context) {
      const answer = await vendorJson(
        context.fetch,
        VENDOR,
        {
          method: "GET",
          url: joinUrl(HUBSPOT_API, "/account-info/v3/details"),
          headers: headers(context),
        },
        AccountAnswer,
        context.now,
      );
      if (!answer.ok) return answer;
      return ok({ accountLabel: `HubSpot account ${answer.value.data.portalId}` });
    },

    pushLead: (context, payload, options) => sync(context, payload, undefined, options.recovery),

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
          message: "HubSpot cannot be signed in again automatically. Connect it again.",
          retryable: false,
          retryAfterSeconds: null,
        });
      }
      const refreshed = await tokenRequest(
        context.fetch,
        VENDOR,
        HUBSPOT_TOKEN_URL,
        {
          grant_type: "refresh_token",
          client_id: options.app.clientId,
          client_secret: options.app.clientSecret,
          refresh_token: credentials.refreshToken,
        },
        context.now,
        credentials.refreshToken,
      );
      return refreshed.ok ? ok(refreshed.value.credentials) : refreshed;
    },
  };
}
