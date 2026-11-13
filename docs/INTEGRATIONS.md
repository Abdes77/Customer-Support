# Integrations: CRMs and outgoing webhooks

What the bot sends to a business's CRM and to webhook receivers, how each one is connected,
what each vendor requires before an app may use its API, and how much of each connector was
checked against the vendor's current documentation. Built by C14 in `packages/integrations`;
the design is in `docs/ARCHITECTURE.md` §2 "As built (C14)", the live checks in
`docs/HUMAN_TODO.md` step 34 (accounts and variables: step 15).

## What happens to a lead

1. Lead scoring (C5) emits `lead.qualified`, `lead.meeting_requested`, `lead.handoff`,
   `lead.disqualified` and `lead.emergency`; scheduling (C12) emits `scheduling.booking_changed`.
2. One job per event plans a **delivery** per connected CRM and per webhook target that wants
   it (`integration_events`, one row each, with an idempotency key made of the event and the
   connection: an event delivered twice plans nothing twice).
3. Each delivery is its own job run (`integrations-deliver`): it pushes the lead the first
   time and updates the same record afterwards. A failure is retried after 1, 5, 15, 60 and
   240 minutes (or the vendor's `Retry-After`, when longer); six attempts, then the delivery
   fails for good and the admin panel can retry it. One failing CRM or webhook never holds up
   another, nor the conversation.
4. A refused sign-in (401) or permission (403) marks the connection "connect it again" at
   once; its deliveries fail with that message, and are queued again by themselves as soon as
   the CRM is connected again (or a connection test passes): nothing waiting for the
   reconnect is lost.
5. **A push whose answer was lost.** Before calling a CRM to create a record, the delivery
   marks the lead's record "push under way" and commits that. If the CRM accepted the push but
   our database write then failed (or the process died mid-call), the next attempt finds the
   mark and asks the connector to look for what the lost push created before creating
   anything: HubSpot and GoHighLevel find the contact by email or phone (whatever the
   duplicates setting); Jobber finds the client by exact email or phone, then a request on it
   with the same title created since the push started; Housecall Pro finds the customer, then
   its newest open lead from our lead source; ServiceTitan finds the booking by our reference
   (`externalId` = `hsrb-lead-<lead id>`). A record already stored for another lead of ours is
   never adopted. What this does not cover: a note (HubSpot, GoHighLevel, Jobber) or a
   GoHighLevel opportunity made by the lost push may be made again; with "always create",
   Jobber may still add a second request when the lost push had created a new client and an
   older client has the same email; Housecall Pro's match relies on it storing our lead source
   as sent (unconfirmed).

What is sent, per business settings (`docs/SETTINGS.md`, category Integrations):

| Setting | Effect |
| --- | --- |
| `integrations.sync_events` | Which events create or update the CRM record (default: qualified, meeting requested, handoff). |
| `integrations.minimum_score` | Leads below it stay out of the CRM; handoffs and emergencies always go. |
| `integrations.update_on_change` | Later events update the same record; an update that changes nothing the CRM shows is skipped. |
| `integrations.duplicates` | Reuse a contact with the same email or phone, or always create one. |
| `integrations.include_report` / `include_transcript` | The written report (and the conversation) as a note on the record. |
| `integrations.lead_source`, `integrations.tags` | Written to the CRM's source and tag fields where it has them. |
| `integrations.field_mapping.<crm>` | Which of our fields go into which CRM fields. Empty = the standard mapping below; with entries, exactly the listed fields are sent. |
| `integrations.webhooks`, `integrations.agency_webhooks` | Webhook targets of the business, and of every business of the agency. |
| `integrations.webhook_include_transcript` | The conversation in webhook bodies. |

**Field mapping.** A row is `{ source, target, transform }`. Sources are paths into the lead
payload: `contact.name`, `contact.firstName`, `contact.lastName`, `contact.phone`,
`contact.email`, `contact.address`, `contact.postalCode`, `lead.score`, `lead.band`,
`lead.status`, `lead.routing`, `lead.report.summary`, `lead.report.markdown`,
`lead.fields.<criterion>` (any answer the bot recorded, e.g. `lead.fields.timeline`),
`business.name`, `conversation.url`, `booking.startsAt`, `sync.leadSource`, `sync.tags` and a
few more (`MAPPING_SOURCES`, which the admin panel lists). Any other path is ignored. Transforms:
text, number, yes/no, date (`YYYY-MM-DD`), phone (`+1...`). The admin panel can preview the
result for a real lead (`previewMapping`).

**Customer text is data.** Names, answers and the report are written by customers. They go
into JSON values and GraphQL variables, never into a query string or a query; HubSpot's note
body, which HubSpot renders as rich text, is HTML-escaped.

## Connecting, per vendor

The admin panel (C16) calls `getIntegrations()` (`apps/web/src/server/integrations`):
OAuth starts with `POST /api/oauth/crm/{hubspot|gohighlevel|jobber}` (JSON `{ businessId,
returnTo }`, answer `{ authorizationUrl }` plus the flow's cookie) and returns to
`returnTo?crm=connected|cancelled|failed|...`; keys go to `POST /api/integrations/crm/{provider}`
(JSON `{ businessId, fields, config? }`), tested before they are stored. Tokens and keys are
encrypted (AES-256-GCM) and never returned to a browser.

Legend for "Checked against docs": **read** = the vendor's current docs were read on
2026-11-12 and the connector follows them; **official sample** = not the API reference but
code or a schema file the vendor publishes; **memory** = no vendor source could be read and
the connector is written from knowledge of the API, to be confirmed by the live check
(`docs/HUMAN_TODO.md` step 34). Nothing here has run against a real account yet.

### HubSpot

- **Connect:** OAuth (a HubSpot public app; `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`;
  redirect URL `{APP_URL}/api/oauth/crm/hubspot/callback`; scopes `oauth
  crm.objects.contacts.read crm.objects.contacts.write`), or a **private app access token**
  per HubSpot account (Settings → Integrations → Private apps, same two CRM scopes).
- **What it does:** finds the contact by email, then phone (unless "always create"), creates
  or updates it with the mapped properties, and keeps one note with the report (and one with
  the transcript) up to date on it. Standard mapping: email, firstname, lastname, phone
  (+1...), address, zip.
- **Approval:** none for a private app or for a public app used by the agency's own
  accounts. Listing the app in HubSpot's marketplace needs HubSpot's review (not needed).
- **Checked against docs:** read: contacts create/update/upsert, notes (`hs_note_body`,
  association type 202), the OAuth authorize URL, the token endpoint `/oauth/v3/token`,
  30-minute access tokens, `hub_id` in the token answer. Memory: the search endpoint
  (`/crm/v3/objects/contacts/search`; search results confirmed its existence and the five
  requests a second per account), `/account-info/v3/details` for the connection test, and
  that notes need no scope beyond the contacts scopes.

### GoHighLevel (HighLevel)

- **Connect:** OAuth (a HighLevel Marketplace app, sub-account (location) level;
  `GOHIGHLEVEL_CLIENT_ID`, `GOHIGHLEVEL_CLIENT_SECRET`; redirect URL
  `{APP_URL}/api/oauth/crm/gohighlevel/callback`; scopes `contacts.readonly contacts.write
  opportunities.write locations.readonly`), or a **Private Integration Token** of the
  sub-account plus its location id.
- **What it does:** upserts the contact (by email or phone, following the location's
  "Allow duplicate contact" setting; `createNewIfDuplicateAllowed` when the settings say
  "always create") with source and tags, keeps one note with the report, and, when a
  pipeline and stage are chosen in the connection's settings (`updateConfig`), opens one
  opportunity per lead. Mapping targets are the contact's fields (`firstName`, `lastName`,
  `email`, `phone`, `address1`, `city`, `state`, `postalCode`, `source`, ...),
  `customField.<key>` or `customFieldId.<id>`.
- **Approval:** a Marketplace app used privately by the agency needs no review; a public
  listing does. Access tokens last about a day; refresh tokens are single-use (stored again on
  every refresh, under the connection's lock).
- **Checked against docs:** read: `POST /contacts/upsert` (fields, duplicate rules, tags
  replace, custom fields `{ id | key, fieldValue }`, no Idempotency-Key), `PUT
  /contacts/{id}`, `POST /contacts/{id}/notes`, the `Version` header (the docs list `v3`),
  the burst limit of 100 requests per 10 seconds per app and location. Memory: the base URL
  `https://services.leadconnectorhq.com`, the authorize page `/oauth/chooselocation`, the
  token endpoint and `user_type=Location`, `PUT` of a note, `POST /opportunities/`, `GET
  /locations/{id}`. If HighLevel rejects `Version: v3`, change `GHL_API_VERSION` in
  `packages/integrations/src/connectors/gohighlevel.ts` to `2021-07-28` (the long-standing value).

### Jobber

- **Connect:** OAuth only (an app in Jobber's Developer Center; `JOBBER_CLIENT_ID`,
  `JOBBER_CLIENT_SECRET`; callback `{APP_URL}/api/oauth/crm/jobber/callback`; scopes are
  chosen on the app: clients read/write, requests write).
- **What it does:** finds the client by email, then phone (unless "always create"; the search
  is loose, so only a client with that exact email or number is reused), else creates it
  (`clientCreate`); creates a request on it (`requestCreate`, titled with the service and the
  business); adds the report as a client note, and adds it again only when it changed.
  Updates edit the client (`clientEdit`). Mapping targets: `firstName`, `lastName`,
  `companyName`, `email`, `phone`, `street1`, `street2`, `city`, `province`, `postalCode`,
  `country`, `title`.
- **Approval:** an app used by the agency's own Jobber accounts can stay unpublished
  (installed by link); publishing it in Jobber's App Marketplace needs Jobber's review.
- **Checked against docs:** the Developer Center (developer.getjobber.com) answers every
  request from the build machine with a bot challenge (tried again on 2026-11-12, directly
  and through search). Per endpoint:

  | What | Source |
  | --- | --- |
  | `POST https://api.getjobber.com/api/graphql`, `Authorization: Bearer`, `X-JOBBER-GRAPHQL-VERSION` header | official sample (Jobber's app templates on GitHub) and search results of the docs |
  | Version value `2025-04-16` | search results of the docs (the templates send `2022-03-10`) |
  | Authorize page `https://api.getjobber.com/api/oauth/authorize` | official sample (React template) |
  | Token endpoint `https://api.getjobber.com/api/oauth/token`, refresh grant, rotation of refresh tokens | memory |
  | Access tokens are JWTs; expiry from the `exp` claim (used when the answer has no `expires_in`) | official sample (Rails template) |
  | `account { id name }`, `clients(searchTerm, first) { nodes { id emails { address } phones { number } } }` | official sample (schema dump, version 2022-03-10) |
  | `clientCreate(input: ClientCreateInput!)`: firstName, lastName, companyName, `emails`/`phones` with description `MAIN`, `billingAddress` (street1, street2, city, province, postalCode, country) | official sample (schema dump) |
  | `clientEdit(clientId, input: ClientEditInput!)` without emails/phones | official sample (schema dump) |
  | `clientCreateNote(clientId, input: { message })` | official sample (schema dump) |
  | `requests(filter: { clientId, createdAt: { after } })` (lost-push lookup) | official sample (schema dump); a refused lookup falls back to creating |
  | `requestCreate(input: { clientId, title })` | **in doubt**: the schema dump also requires `customFormInput: { formId }`, which we do not send; whether version 2025-04-16 still does is unconfirmed |
  | Throttling as a GraphQL error with code `THROTTLED`, rate limits | memory |

  Check them in Jobber's GraphiQL explorer (live check) before the first real business; if
  `requestCreate` needs a form id, the connection will need a setting for it.

### Housecall Pro

- **Connect:** an **API key** (Housecall Pro MAX plan: App Store → API → generate key). The
  OAuth app variables (`HOUSECALL_PRO_CLIENT_*`) are reserved for a partner app and unused.
- **What it does:** finds the customer by email, then mobile number (unless "always create";
  `q` also matches names and addresses, so only a customer with that exact email or number
  is reused), else creates it (with an address, the lead source and tags, and Housecall
  Pro's own notifications off), then creates a lead on it carrying the report as its note. Updates
  change the customer's fields; later report changes stay in our admin panel. Mapping
  targets: `first_name`, `last_name`, `email`, `mobile_number`, `home_number`,
  `work_number`, `company`, `lead_source`, `address.street|city|state|zip`.
- **Approval:** none beyond the MAX plan. In Housecall Pro, switch on **API Leads** (Job
  Inbox settings) so API leads show in the Job Inbox.
- **Checked against docs:** read on 2026-11-12: the docs site renders in a browser only, but
  its OpenAPI file ("Housecall v1 API", Stoplight project `housecall-public-api`) and the
  Authentication article were read through Stoplight's API. Per endpoint:

  | What | Source |
  | --- | --- |
  | Base URL `https://api.housecallpro.com`, `Authorization: Token <key>` (OAuth only for approved partners) | read |
  | `GET /customers?q=&page_size=` (`q` searches name, email, mobile number, address) | read |
  | `POST /customers` (`CustomerCreate`: names, email, numbers, company, `notifications_enabled`, `lead_source`, `tags`, `addresses[]` of street, street_line_2, city, state, zip, country) | read (an address `type` the first build sent is not in it and was removed) |
  | `PUT /customers/{id}` (`CustomerUpdate`, no addresses) | read |
  | `POST /leads` (`customer_id`, `address_id`, `lead_source`, `tags`, `note`; 201 with `id`) | read |
  | `GET /leads?customer_id=&sort_by=created_at&sort_direction=desc` (lost-push lookup; `status`, `lead_source` in the answer) | read |
  | `GET /company` (`name`) for the connection test | read |
  | `Idempotency-Key` header (sent, not relied on) | not in the docs |
  | Link `https://pro.housecallpro.com/app/customers/{id}`, rate limits, error body shape | memory |
  | MAX plan, the API Leads switch | help center |

### ServiceTitan

- **Connect:** client credentials per ServiceTitan tenant (tenant id, client id, client
  secret, from the tenant's Settings → Integrations → API Application Access, after the
  tenant connects our app) plus our app key (`SERVICETITAN_APP_KEY`, environment
  `SERVICETITAN_ENVIRONMENT` = `integration` or `production`). Then choose the **booking
  provider** (the tenant creates one for us: Settings → Integrations → Booking Providers) in
  the connection's settings; optionally a campaign, business unit and job type.
- **What it does:** creates a booking in the tenant's call-booking screen for its CSRs
  (name, summary with the report, phone and email contacts, source, our reference
  `hsrb-lead-<lead id>` as `externalId`), and updates the same booking later. An address is
  sent only when street, city, state and ZIP are all mapped (ServiceTitan requires them all;
  the standard mapping has the street line and ZIP only, which then go into the summary). Map
  `address.city` and `address.state` (e.g. from `lead.fields.<key>`) to send a structured
  address. `customerType` is Residential unless a mapping gives Residential or Commercial.
- **Approval:** required. Our app must be created and approved in ServiceTitan's Developer
  Portal (Integration environment first, then Production after ServiceTitan's review), with
  the CRM bookings scopes; each tenant then grants it access. Without approval no tenant can
  connect.
- **Checked against docs:** read on 2026-11-12: the Developer Portal renders in a browser
  only, but the OpenAPI document it loads for the CRM API
  (`https://developer.servicetitan.io/api/docs/apis/tenant-crm`) was read. Per endpoint:

  | What | Source |
  | --- | --- |
  | `ST-App-Key` header and OAuth client credentials at `https://auth.servicetitan.io/connect/token`; scopes `tn.crm.bookings:r`, `tn.crm.bookings:w` | read |
  | Hosts `api.servicetitan.io` (production), `api-integration.servicetitan.io` (integration) | read |
  | `auth-integration.servicetitan.io` for the integration environment's tokens, a 900-second token lifetime | integrators' guides / memory |
  | `POST /crm/v2/tenant/{tenant}/booking-provider/{provider}/bookings` (`CreateBookingRequest`: source, name, summary, isFirstTimeClient, externalId required; unknown fields refused) | read; the first build sent an address without city and state, which the schema refuses: fixed |
  | `PATCH .../bookings/{id}` (`UpdateBookingRequest`: no contacts, the address needs every field) | read; the first build sent contacts: fixed |
  | `GET .../bookings?externalId=&pageSize=` (lost-push lookup and connection test) | read |
  | Whether ServiceTitan refuses a second booking with the same `externalId` | not in the docs: we look it up instead |

## The generic signed webhook (Zapier, Make, your own system)

Add a target in the settings (name, `https://` address, events, active). Every request is a
`POST` with a JSON body:

```json
{
  "id": "<delivery key>", "type": "lead.qualified", "createdAt": "2026-11-12T15:00:00.000Z",
  "business": { "id": "...", "name": "Summit Roofing" },
  "lead": { "id": "...", "status": "qualified", "score": 82, "band": "hot", "routing": "book_meeting",
            "fields": { "service_type": "roof leak repair", "timeline": "this_week" },
            "createdAt": "...", "updatedAt": "..." },
  "report": { "summary": "...", "markdown": "..." },
  "contact": { "name": "Pat Lee", "firstName": "Pat", "lastName": "Lee", "phone": "+15125550199",
               "email": "pat@example.com", "address": "...", "postalCode": "78704" },
  "conversation": { "id": "...", "channel": "whatsapp", "url": "https://.../inbox/..." },
  "booking": null
}
```

`type` is one of the five lead events, or `booking.confirmed|moved|cancelled` for targets
that chose "A meeting is requested or booked"; `transcript` is added only when
`integrations.webhook_include_transcript` is on. Headers: `X-HSRB-Event`, `X-HSRB-Delivery`
and `Idempotency-Key` (the same value: deduplicate on it, a delivery may arrive more than once
when an answer is lost), and the signature:

```
X-HSRB-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
```

To verify (Node.js; `verifyWebhookSignature` in `@repo/integrations` does the same):

```js
const crypto = require("node:crypto");
function verify(secret, header, rawBody) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const want = crypto.createHmac("sha256", secret).update(`${parts.t}.${rawBody}`).digest();
  const given = Buffer.from(parts.v1 ?? "", "hex");
  const fresh = Math.abs(Date.now() / 1000 - Number(parts.t)) <= 300; // refuse replays
  return fresh && given.length === want.length && crypto.timingSafeEqual(given, want);
}
```

The signing secret (`whsec_...`) is per target: a business target's is stored with the
business, an agency target's is one secret for every business of the agency. Only agency
admins reveal or rotate it (`revealWebhookSecret`, `rotateWebhookSecret` and the agency
versions take the person's access and refuse agency members and client users; every reveal
and rotation is in the audit log, without the secret; the secret is never logged). Zapier ("Webhooks by Zapier → Catch
Hook") and Make ("Custom webhook") accept the requests as they are; they do not check the
signature, so treat their hook URLs as secrets.

**Address rules.** A webhook address is typed by a person, so the sender refuses anything that
could reach our own network: `https://` only, the standard port only, no user name or
password, no private host names (`localhost`, `*.local`, `*.internal`, single labels), every
address of the name public (private, loopback, link-local and metadata ranges and the IPv6
forms wrapping them are refused), the connection pinned to the checked address, redirects not
followed (a 3xx fails the delivery: use the final address), ten seconds per request, the
answer's body discarded. `checkWebhookUrl` runs the same checks for the settings form.
A 2xx answer is success; 408, 429 and 5xx are retried; other answers fail the delivery.

## Errors in the admin panel

`list()` shows each CRM connection's status (`active`, `error` = connect again, `disabled`),
its last error and last successful delivery; `webhookTargets()` the same per target, with the
secret's last four characters. `deliveries()` is the log: event, status (pending, succeeded,
skipped with a reason, failed), attempts, the vendor's safe error message, the external id
and link. `retry()` runs a failed delivery again; `test()` and `testWebhook()` check a
connection. Messages never contain a token, a key or the customer's data: a vendor's error
text is shown with email addresses, quoted values, phone-like numbers and token-like strings
taken out, and a webhook receiver's answer is reduced to its status code (its body is never
read past 64 KB, stored or shown).
