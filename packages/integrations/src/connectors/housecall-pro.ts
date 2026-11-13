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
import { applyFieldMapping, type MappedFields, mappedText, sameEmail, samePhone } from "../mapping";
import { reportNote, transcriptNote } from "../payload";

/*
 * Housecall Pro (public REST API, `https://api.housecallpro.com`). Checked on 2026-11-12
 * against Housecall Pro's OpenAPI file (the Stoplight project "housecall-public-api", read
 * through Stoplight's API since the docs site renders in a browser only): `Authorization:
 * Token <key>`; `GET /customers?q=&page_size=` (`q` searches names, emails, mobile numbers
 * and addresses, so a hit is reused only on an exact email or number); `POST /customers`
 * (`CustomerCreate`: names, email, numbers, `notifications_enabled`, `lead_source`, `tags`,
 * `addresses[]` of street, street_line_2, city, state, zip, country); `PUT
 * /customers/{id}` (`CustomerUpdate`, no addresses); `POST /leads` (`customer_id`,
 * `address_id`, `lead_source`, `tags`, `note`; 201 with the lead); `GET
 * /leads?customer_id=&sort_by=created_at&sort_direction=desc` (used to find a lead a lost
 * push made); `GET /company`. Not in those docs, so not relied on: an Idempotency-Key header
 * (sent, harmless), the link to a customer in Housecall Pro's web app, rate limits. The API
 * is for companies on the MAX plan; API leads show in the Job Inbox once "API Leads" is on
 * (help center).
 *
 * A lead becomes a customer (reused by email or phone unless the settings say otherwise) and
 * a lead on it; the report goes into the lead's note when the lead is created. Housecall Pro
 * has no note endpoint for leads in its docs, so later report changes stay in our panel.
 */

export const HOUSECALL_API = "https://api.housecallpro.com";
const VENDOR = "Housecall Pro";

export const HousecallProCredentials = z.object({
  kind: z.literal("api_key"),
  apiKey: z.string().min(10).max(500),
});
export type HousecallProCredentials = z.infer<typeof HousecallProCredentials>;

export const HousecallProConfig = z.object({});
export type HousecallProConfig = z.infer<typeof HousecallProConfig>;

type Context = ConnectorContext<HousecallProCredentials, HousecallProConfig>;

const CUSTOMER_FIELDS = [
  "first_name",
  "last_name",
  "email",
  "mobile_number",
  "home_number",
  "work_number",
  "company",
] as const;
const ADDRESS_FIELDS = ["street", "street_line_2", "city", "state", "zip", "country"] as const;

const CustomerAnswer = z
  .object({
    id: z.string().min(1),
    email: z.string().nullable().optional(),
    mobile_number: z.string().nullable().optional(),
    home_number: z.string().nullable().optional(),
    work_number: z.string().nullable().optional(),
    addresses: z.array(z.object({ id: z.string().min(1) }).passthrough()).optional(),
  })
  .passthrough();
const SearchAnswer = z.object({ customers: z.array(CustomerAnswer) }).passthrough();
const LeadAnswer = z.object({ id: z.string().min(1) }).passthrough();
const LeadList = z
  .object({
    leads: z.array(
      z
        .object({
          id: z.string().min(1),
          status: z.string().nullable().optional(),
          lead_source: z.string().nullable().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const CompanyAnswer = z
  .object({ name: z.string().optional(), id: z.string().optional() })
  .passthrough();

function headers(context: Context): Record<string, string> {
  return { authorization: `Token ${context.credentials.apiKey}` };
}

/** The customer body from the mapped fields; `address.<field>` targets form the address. */
export function housecallCustomerBody(
  fields: MappedFields,
  options: { readonly leadSource: string; readonly tags: readonly string[] },
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of CUSTOMER_FIELDS) {
    const value = mappedText(fields, key);
    if (value !== null) body[key] = value;
  }
  const address: Record<string, string> = {};
  for (const key of ADDRESS_FIELDS) {
    const value = mappedText(fields, `address.${key}`);
    if (value !== null) address[key] = value;
  }
  // `CustomerCreate.addresses[]` takes street, street_line_2, city, state, zip and country.
  if (Object.keys(address).length > 0) body["addresses"] = [address];
  body["lead_source"] = mappedText(fields, "lead_source") ?? options.leadSource;
  if (options.tags.length > 0) body["tags"] = [...options.tags];
  // The bot does not opt the customer into Housecall Pro's own texts and emails.
  body["notifications_enabled"] = false;
  return body;
}

async function findCustomer(
  context: Context,
  fields: MappedFields,
): Promise<Result<z.infer<typeof CustomerAnswer> | null, ConnectorError>> {
  const email = mappedText(fields, "email");
  const phone = mappedText(fields, "mobile_number");
  for (const term of [email, phone]) {
    if (term === null) continue;
    const url = new URL(joinUrl(HOUSECALL_API, "/customers"));
    // `q` searches names, emails, mobile numbers and addresses (Housecall Pro's docs).
    url.searchParams.set("q", term);
    url.searchParams.set("page_size", "5");
    const found = await vendorJson(
      context.fetch,
      VENDOR,
      { method: "GET", url: url.toString(), headers: headers(context) },
      SearchAnswer,
      context.now,
    );
    if (!found.ok) return found;
    // Only a customer with this exact email or number, never a loose match.
    const match = found.value.data.customers.find((customer) =>
      term === email
        ? sameEmail(customer.email, email)
        : [customer.mobile_number, customer.home_number, customer.work_number].some((number) =>
            samePhone(number, phone),
          ),
    );
    if (match !== undefined) return ok(match);
  }
  return ok(null);
}

/**
 * The lead a lost push may have made for this customer (`GET /leads?customer_id=`, newest
 * first): open, from our lead source, and not stored for another lead of ours. Null when there
 * is none, or when the lookup is refused as invalid (then a new lead is the lesser evil).
 */
async function findLostLead(
  context: Context,
  customerId: string,
  leadSource: string,
  recovery: PushRecovery,
): Promise<Result<string | null, ConnectorError>> {
  const url = new URL(joinUrl(HOUSECALL_API, "/leads"));
  url.searchParams.set("customer_id", customerId);
  url.searchParams.set("sort_by", "created_at");
  url.searchParams.set("sort_direction", "desc");
  url.searchParams.set("page_size", "10");
  const found = await vendorJson(
    context.fetch,
    VENDOR,
    { method: "GET", url: url.toString(), headers: headers(context) },
    LeadList,
    context.now,
  );
  if (!found.ok) return found.error.code === "validation" ? ok(null) : found;
  for (const lead of found.value.data.leads) {
    if ((lead.status ?? "open") !== "open" || lead.lead_source !== leadSource) continue;
    if (!(await recovery.isKnownRecord(lead.id))) return ok(lead.id);
  }
  return ok(null);
}

async function push(
  context: Context,
  payload: LeadSyncPayload,
  idempotencyKey: string,
  recovery: PushRecovery | undefined,
): Promise<Result<ExternalRecord, ConnectorError>> {
  const { fields } = applyFieldMapping(payload, context.fieldMapping, context.options);
  let customer: z.infer<typeof CustomerAnswer> | null = null;
  // Recovering an unrecorded push looks the customer up whatever the duplicates setting: the
  // lost push may have created it.
  if (context.options.duplicates === "update_existing" || recovery !== undefined) {
    const found = await findCustomer(context, fields);
    if (!found.ok) return found;
    customer = found.value;
  }
  const leadSource = mappedText(fields, "lead_source") ?? context.options.leadSource;
  if (customer !== null && recovery !== undefined) {
    const lost = await findLostLead(context, customer.id, leadSource, recovery);
    if (!lost.ok) return lost;
    if (lost.value !== null) {
      return ok({
        externalId: lost.value,
        externalUrl: `https://pro.housecallpro.com/app/customers/${segment(customer.id)}`,
        state: { customerId: customer.id },
      });
    }
  }
  if (customer === null) {
    const created = await vendorJson(
      context.fetch,
      VENDOR,
      {
        method: "POST",
        url: joinUrl(HOUSECALL_API, "/customers"),
        headers: { ...headers(context), "idempotency-key": `${idempotencyKey}:customer` },
        json: housecallCustomerBody(fields, context.options),
      },
      CustomerAnswer,
      context.now,
    );
    if (!created.ok) return created;
    customer = created.value.data;
  }
  const notes = [
    context.options.includeReport ? reportNote(payload) : null,
    context.options.includeTranscript ? transcriptNote(payload) : null,
  ].filter((note): note is string => note !== null);
  const addressId = customer.addresses?.[0]?.id;
  const lead = await vendorJson(
    context.fetch,
    VENDOR,
    {
      method: "POST",
      url: joinUrl(HOUSECALL_API, "/leads"),
      headers: { ...headers(context), "idempotency-key": `${idempotencyKey}:lead` },
      json: {
        customer_id: customer.id,
        ...(addressId === undefined ? {} : { address_id: addressId }),
        lead_source: leadSource,
        ...(context.options.tags.length > 0 ? { tags: [...context.options.tags] } : {}),
        ...(notes.length > 0 ? { note: notes.join("\n\n").slice(0, 60_000) } : {}),
      },
    },
    LeadAnswer,
    context.now,
  );
  if (!lead.ok) return lead;
  return ok({
    externalId: lead.value.data.id,
    externalUrl: `https://pro.housecallpro.com/app/customers/${segment(customer.id)}`,
    state: { customerId: customer.id },
  });
}

async function update(
  context: Context,
  externalId: string,
  payload: LeadSyncPayload,
  record: ExternalRecord | undefined,
): Promise<Result<ExternalRecord, ConnectorError>> {
  const customerId = record?.state?.["customerId"];
  if (customerId === undefined) {
    return err(
      connectorError("not_found", "The Housecall Pro customer of this lead is not known.", {
        retryable: false,
      }),
    );
  }
  const { fields } = applyFieldMapping(payload, context.fieldMapping, context.options);
  const {
    addresses: _addresses,
    notifications_enabled: _n,
    ...body
  } = housecallCustomerBody(fields, context.options);
  const updated = await vendorJson(
    context.fetch,
    VENDOR,
    {
      method: "PUT",
      url: joinUrl(HOUSECALL_API, `/customers/${segment(customerId)}`),
      headers: headers(context),
      json: body,
    },
    CustomerAnswer,
    context.now,
  );
  if (!updated.ok) return updated;
  return ok({
    externalId,
    externalUrl: record?.externalUrl ?? null,
    state: { customerId },
  });
}

export function createHousecallProConnector(): IntegrationConnector<
  HousecallProCredentials,
  HousecallProConfig
> {
  return {
    id: "housecall_pro",
    displayName: "Housecall Pro",
    auth: {
      type: "api_key",
      fields: [{ key: "apiKey", label: "API key (Housecall Pro MAX plan)", secret: true }],
    },
    credentialsSchema: HousecallProCredentials,
    configSchema: HousecallProConfig,
    defaultFieldMapping: [
      { source: "contact.firstName", target: "first_name" },
      { source: "contact.lastName", target: "last_name" },
      { source: "contact.email", target: "email" },
      { source: "contact.phone", target: "mobile_number", transform: "phone_e164" },
      { source: "contact.address", target: "address.street" },
      { source: "contact.postalCode", target: "address.zip" },
    ],

    async testConnection(context) {
      const answer = await vendorJson(
        context.fetch,
        VENDOR,
        { method: "GET", url: joinUrl(HOUSECALL_API, "/company"), headers: headers(context) },
        CompanyAnswer,
        context.now,
      );
      if (!answer.ok) return answer;
      return ok({ accountLabel: answer.value.data.name ?? "Housecall Pro company" });
    },

    pushLead: (context, payload, options) =>
      push(context, payload, options.idempotencyKey, options.recovery),
    updateLead: (context, externalId, payload, options) =>
      update(context, externalId, payload, options.record),
  };
}
