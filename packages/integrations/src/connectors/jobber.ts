import { createHash } from "node:crypto";

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

import { connectorError, redactVendorText, vendorJson } from "../http";
import { applyFieldMapping, type MappedFields, mappedText, sameEmail, samePhone } from "../mapping";
import { leadTitle, reportNote, transcriptNote } from "../payload";
import { type OAuthApp, OAuthCredentials, oauthExpiresSoon, tokenRequest } from "./common";

/*
 * Jobber (GraphQL API). Jobber's developer docs refused requests from the build machine on
 * 2026-11-12. Checked instead against Jobber's own app template
 * (github.com/GetJobber/Jobber-AppTemplate-RailsAPI and -React): the API at
 * `https://api.getjobber.com/api/graphql` with a bearer token and the
 * `X-JOBBER-GRAPHQL-VERSION` header, the authorize page
 * `https://api.getjobber.com/api/oauth/authorize`, access tokens that are JWTs whose `exp`
 * claim gives the expiry. The token endpoint `/api/oauth/token` is from memory (the template
 * leaves it to its OAuth library's default); and against the schema dump
 * committed there (an older API version, 2022-03-10): `account { id name }`,
 * `clients(searchTerm, first)` with `emails { address }` and `phones { number }`,
 * `clientCreate(input: ClientCreateInput!)` (firstName, lastName, companyName, emails and
 * phones with description MAIN, billingAddress street1/street2/city/province/postalCode/
 * country), `clientEdit(clientId, input: ClientEditInput!)` (emails and phones are not
 * fields of it), `clientCreateNote(clientId, input: { message })`, `requests(filter:
 * { clientId, createdAt: { after } })`. In that schema `RequestCreateInput` also requires
 * `customFormInput: { formId }`, which this connector does not send: whether the version we
 * send (2025-04-16, from search results of the docs) still requires it is unconfirmed; the
 * live check (docs/HUMAN_TODO.md 17) settles it.
 *
 * A lead becomes a client (reused by exact email or phone unless the settings say otherwise)
 * and a request on it; the report is a note on the client, added again only when it changed.
 * Every value travels as a GraphQL variable: customer text never becomes part of the query.
 */

export const JOBBER_GRAPHQL_URL = "https://api.getjobber.com/api/graphql";
export const JOBBER_AUTHORIZE_URL = "https://api.getjobber.com/api/oauth/authorize";
export const JOBBER_TOKEN_URL = "https://api.getjobber.com/api/oauth/token";
export const JOBBER_API_VERSION = "2025-04-16";
const VENDOR = "Jobber";

export const JobberCredentials = OAuthCredentials;
export type JobberCredentials = z.infer<typeof JobberCredentials>;

export const JobberConfig = z.object({
  accountName: z.string().nullable().default(null),
});
export type JobberConfig = z.infer<typeof JobberConfig>;

type Context = ConnectorContext<JobberCredentials, JobberConfig>;

const UserErrors = z.array(
  z.object({ message: z.string(), path: z.array(z.unknown()).optional() }),
);

const GraphQlAnswer = z.object({
  data: z.record(z.string(), z.unknown()).nullable().optional(),
  errors: z
    .array(
      z
        .object({
          message: z.string(),
          extensions: z.object({ code: z.string().optional() }).passthrough().optional(),
        })
        .passthrough(),
    )
    .optional(),
});

/** One GraphQL operation; `variables` carry every value. */
async function graphql<T>(
  context: Context,
  query: string,
  variables: Record<string, unknown>,
  pick: z.ZodType<T>,
): Promise<Result<T, ConnectorError>> {
  const answer = await vendorJson(
    context.fetch,
    VENDOR,
    {
      method: "POST",
      url: JOBBER_GRAPHQL_URL,
      headers: {
        authorization: `Bearer ${context.credentials.accessToken}`,
        "x-jobber-graphql-version": JOBBER_API_VERSION,
      },
      json: { query, variables },
    },
    GraphQlAnswer,
    context.now,
  );
  if (!answer.ok) return answer;
  const errors = answer.value.data.errors ?? [];
  if (errors.length > 0) {
    const first = errors[0]!;
    const code = first.extensions?.code ?? "";
    if (code === "THROTTLED" || /throttl/i.test(first.message)) {
      return err(
        connectorError("rate_limited", "Jobber is throttling requests.", {
          retryable: true,
          retryAfterSeconds: 30,
        }),
      );
    }
    if (code === "UNAUTHENTICATED") {
      return err(
        connectorError("auth_expired", "Jobber refused the stored sign-in. Connect it again.", {
          retryable: false,
        }),
      );
    }
    return err(
      connectorError(
        "validation",
        `Jobber refused the request: ${redactVendorText(first.message)}`,
        {
          retryable: false,
        },
      ),
    );
  }
  const picked = pick.safeParse(answer.value.data.data ?? {});
  if (!picked.success) {
    return err(
      connectorError("unknown", "Jobber answered in an unexpected shape.", { retryable: true }),
    );
  }
  return ok(picked.data);
}

function userErrorsOf(errors: readonly { message: string }[]): ConnectorError | null {
  if (errors.length === 0) return null;
  return connectorError(
    "validation",
    `Jobber refused the data: ${redactVendorText(errors.map((error) => error.message).join("; "))}`,
    { retryable: false },
  );
}

/** The client input from the mapped fields (Jobber's own shape). */
export function jobberClientInput(fields: MappedFields): Record<string, unknown> {
  const text = (key: string) => mappedText(fields, key);
  const input: Record<string, unknown> = {};
  for (const key of ["firstName", "lastName", "companyName"]) {
    const value = text(key);
    if (value !== null) input[key] = value;
  }
  const email = text("email");
  if (email !== null) input["emails"] = [{ description: "MAIN", primary: true, address: email }];
  const phone = text("phone");
  if (phone !== null) input["phones"] = [{ description: "MAIN", primary: true, number: phone }];
  const address: Record<string, string> = {};
  for (const key of ["street1", "street2", "city", "province", "postalCode", "country"]) {
    const value = text(key);
    if (value !== null) address[key] = value;
  }
  if (Object.keys(address).length > 0) input["billingAddress"] = address;
  // Jobber requires a name or a company on a client.
  if (
    input["firstName"] === undefined &&
    input["lastName"] === undefined &&
    input["companyName"] === undefined
  ) {
    input["firstName"] = email ?? phone ?? "New lead";
  }
  return input;
}

const CLIENT_SEARCH = `query FindClient($term: String!) {
  clients(searchTerm: $term, first: 5) { nodes { id emails { address } phones { number } } }
}`;
const CLIENT_CREATE = `mutation CreateClient($input: ClientCreateInput!) {
  clientCreate(input: $input) { client { id jobberWebUri } userErrors { message path } }
}`;
const CLIENT_EDIT = `mutation EditClient($clientId: EncodedId!, $input: ClientEditInput!) {
  clientEdit(clientId: $clientId, input: $input) { client { id } userErrors { message path } }
}`;
const REQUEST_CREATE = `mutation CreateRequest($input: RequestCreateInput!) {
  requestCreate(input: $input) { request { id jobberWebUri } userErrors { message path } }
}`;
const NOTE_CREATE = `mutation CreateNote($clientId: EncodedId!, $input: ClientCreateNoteInput!) {
  clientCreateNote(clientId: $clientId, input: $input) { clientNote { id } userErrors { message path } }
}`;
const REQUEST_SEARCH = `query FindRequests($clientId: EncodedId!, $after: ISO8601DateTime!) {
  requests(filter: { clientId: $clientId, createdAt: { after: $after } }, first: 10) {
    nodes { id title jobberWebUri }
  }
}`;
const ACCOUNT = `query Account { account { id name } }`;

const SearchData = z.object({
  clients: z.object({
    nodes: z.array(
      z.object({
        id: z.string().min(1),
        emails: z.array(z.object({ address: z.string() })).optional(),
        phones: z.array(z.object({ number: z.string() })).optional(),
      }),
    ),
  }),
});
const ClientCreateData = z.object({
  clientCreate: z.object({
    client: z
      .object({ id: z.string().min(1), jobberWebUri: z.string().nullable().optional() })
      .nullable(),
    userErrors: UserErrors,
  }),
});
const ClientEditData = z.object({
  clientEdit: z.object({
    client: z.object({ id: z.string().min(1) }).nullable(),
    userErrors: UserErrors,
  }),
});
const RequestCreateData = z.object({
  requestCreate: z.object({
    request: z
      .object({ id: z.string().min(1), jobberWebUri: z.string().nullable().optional() })
      .nullable(),
    userErrors: UserErrors,
  }),
});
const NoteCreateData = z.object({
  clientCreateNote: z.object({
    clientNote: z.object({ id: z.string().min(1) }).nullable(),
    userErrors: UserErrors,
  }),
});
const RequestSearchData = z.object({
  requests: z.object({
    nodes: z.array(
      z.object({
        id: z.string().min(1),
        title: z.string().nullable().optional(),
        jobberWebUri: z.string().nullable().optional(),
      }),
    ),
  }),
});
const AccountData = z.object({ account: z.object({ id: z.string(), name: z.string() }) });

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

async function addNotes(
  context: Context,
  clientId: string,
  payload: LeadSyncPayload,
  state: Record<string, string>,
): Promise<Result<void, ConnectorError>> {
  const notes = [
    ["reportHash", context.options.includeReport ? reportNote(payload) : null],
    ["transcriptHash", context.options.includeTranscript ? transcriptNote(payload) : null],
  ] as const;
  for (const [key, text] of notes) {
    if (text === null || state[key] === hash(text)) continue;
    const note = await graphql(
      context,
      NOTE_CREATE,
      { clientId, input: { message: text } },
      NoteCreateData,
    );
    if (!note.ok) return note;
    const problem = userErrorsOf(note.value.clientCreateNote.userErrors);
    if (problem !== null) return err(problem);
    state[key] = hash(text);
  }
  return ok(undefined);
}

/**
 * The request a lost push may have made on this client: created since the push started, with
 * the same title, and not stored for another lead of ours. A lookup Jobber refuses as invalid
 * (the query is from the schema in Jobber's app template; the current version is unchecked)
 * counts as "none", so recovery never blocks a push.
 */
async function findLostRequest(
  context: Context,
  clientId: string,
  title: string,
  recovery: PushRecovery,
): Promise<Result<{ id: string; jobberWebUri: string | null } | null, ConnectorError>> {
  const found = await graphql(
    context,
    REQUEST_SEARCH,
    { clientId, after: recovery.since.toISOString() },
    RequestSearchData,
  );
  if (!found.ok) return found.error.code === "validation" ? ok(null) : found;
  for (const request of found.value.requests.nodes) {
    if (request.title !== title) continue;
    if (!(await recovery.isKnownRecord(request.id))) {
      return ok({ id: request.id, jobberWebUri: request.jobberWebUri ?? null });
    }
  }
  return ok(null);
}

async function push(
  context: Context,
  payload: LeadSyncPayload,
  recovery: PushRecovery | undefined,
): Promise<Result<ExternalRecord, ConnectorError>> {
  const { fields } = applyFieldMapping(payload, context.fieldMapping, context.options);
  let clientId: string | null = null;
  // Recovering an unrecorded push looks the client up whatever the duplicates setting: the
  // lost push may have created it.
  if (context.options.duplicates === "update_existing" || recovery !== undefined) {
    const email = mappedText(fields, "email");
    const phone = mappedText(fields, "phone");
    for (const term of [email, phone]) {
      if (term === null) continue;
      const found = await graphql(context, CLIENT_SEARCH, { term }, SearchData);
      if (!found.ok) return found;
      // The search matches loosely (names, addresses): take only a client that has this
      // exact email or phone, never someone else's record.
      const match = found.value.clients.nodes.find(
        (client) =>
          (term === email && (client.emails ?? []).some((e) => sameEmail(e.address, email))) ||
          (term === phone && (client.phones ?? []).some((p) => samePhone(p.number, phone))),
      );
      clientId = match?.id ?? null;
      if (clientId !== null) break;
    }
  }
  if (clientId === null) {
    const created = await graphql(
      context,
      CLIENT_CREATE,
      { input: jobberClientInput(fields) },
      ClientCreateData,
    );
    if (!created.ok) return created;
    const problem = userErrorsOf(created.value.clientCreate.userErrors);
    if (problem !== null) return err(problem);
    if (created.value.clientCreate.client === null) {
      return err(connectorError("unknown", "Jobber created no client.", { retryable: true }));
    }
    clientId = created.value.clientCreate.client.id;
  }
  const title = mappedText(fields, "title") ?? leadTitle(payload);
  if (recovery !== undefined) {
    const lost = await findLostRequest(context, clientId, title, recovery);
    if (!lost.ok) return lost;
    if (lost.value !== null) {
      const state: Record<string, string> = { clientId };
      const notes = await addNotes(context, clientId, payload, state);
      if (!notes.ok) return notes;
      return ok({ externalId: lost.value.id, externalUrl: lost.value.jobberWebUri, state });
    }
  }
  const request = await graphql(
    context,
    REQUEST_CREATE,
    { input: { clientId, title } },
    RequestCreateData,
  );
  if (!request.ok) return request;
  const problem = userErrorsOf(request.value.requestCreate.userErrors);
  if (problem !== null) return err(problem);
  const created = request.value.requestCreate.request;
  if (created === null) {
    return err(connectorError("unknown", "Jobber created no request.", { retryable: true }));
  }
  const state: Record<string, string> = { clientId };
  const notes = await addNotes(context, clientId, payload, state);
  if (!notes.ok) return notes;
  return ok({ externalId: created.id, externalUrl: created.jobberWebUri ?? null, state });
}

async function update(
  context: Context,
  externalId: string,
  payload: LeadSyncPayload,
  record: ExternalRecord | undefined,
): Promise<Result<ExternalRecord, ConnectorError>> {
  const state: Record<string, string> = { ...record?.state };
  const clientId = state["clientId"];
  if (clientId === undefined) {
    return err(
      connectorError("not_found", "The Jobber client of this lead is not known.", {
        retryable: false,
      }),
    );
  }
  const { fields } = applyFieldMapping(payload, context.fieldMapping, context.options);
  const { emails: _emails, phones: _phones, ...input } = jobberClientInput(fields);
  const edited = await graphql(context, CLIENT_EDIT, { clientId, input }, ClientEditData);
  if (!edited.ok) return edited;
  const problem = userErrorsOf(edited.value.clientEdit.userErrors);
  if (problem !== null) return err(problem);
  const notes = await addNotes(context, clientId, payload, state);
  if (!notes.ok) return notes;
  return ok({ externalId, externalUrl: record?.externalUrl ?? null, state });
}

export function createJobberConnector(
  options: { readonly app: OAuthApp | null } = { app: null },
): IntegrationConnector<JobberCredentials, JobberConfig> {
  return {
    id: "jobber",
    displayName: "Jobber",
    auth: {
      type: "oauth2",
      authorizeUrl: JOBBER_AUTHORIZE_URL,
      tokenUrl: JOBBER_TOKEN_URL,
      scopes: [],
    },
    credentialsSchema: JobberCredentials,
    configSchema: JobberConfig,
    defaultFieldMapping: [
      { source: "contact.firstName", target: "firstName" },
      { source: "contact.lastName", target: "lastName" },
      { source: "contact.email", target: "email" },
      { source: "contact.phone", target: "phone", transform: "phone_e164" },
      { source: "contact.address", target: "street1" },
      { source: "contact.postalCode", target: "postalCode" },
    ],

    async testConnection(context) {
      const answer = await graphql(context, ACCOUNT, {}, AccountData);
      return answer.ok ? ok({ accountLabel: answer.value.account.name }) : answer;
    },

    pushLead: (context, payload, options) => push(context, payload, options.recovery),
    updateLead: (context, externalId, payload, opts) =>
      update(context, externalId, payload, opts.record),

    credentialsExpireSoon: (credentials, now) => oauthExpiresSoon(credentials, now),

    async refreshCredentials(context) {
      const credentials = context.credentials;
      if (options.app === null || credentials.refreshToken === null) {
        return err({
          code: "auth_expired",
          message: "Jobber cannot be signed in again automatically. Connect it again.",
          retryable: false,
          retryAfterSeconds: null,
        });
      }
      const refreshed = await tokenRequest(
        context.fetch,
        VENDOR,
        JOBBER_TOKEN_URL,
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
