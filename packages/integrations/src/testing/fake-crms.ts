import type { FetchLike } from "../http";

/*
 * Fakes of the five CRMs' APIs behind one injected `fetch`, for contract tests and the
 * database tests. Each answers with the shape of the vendor's recorded answers (the fixtures
 * in `fixtures.ts`), keeps the records it was given, and records every request so a test can
 * check the method, the path, the headers and the body. `failNext` makes the next matching
 * request fail the way the vendor fails (status, body, Retry-After).
 *
 * Shapes follow the vendors' docs where they were readable (docs/INTEGRATIONS.md says which);
 * the rest is how the APIs answered when last used, written from memory.
 */

export interface RecordedRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  /** Parsed JSON, the form as an object, or null. */
  readonly body: unknown;
  readonly rawBody: string;
}

export interface CannedFailure {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface FakeCrms {
  readonly fetch: FetchLike;
  readonly requests: RecordedRequest[];
  /** Requests whose host and path match. */
  requestsTo(host: string, pathPattern?: RegExp): RecordedRequest[];
  /** The next request to `host` matching `pathPattern` (and method) answers with this. */
  failNext(host: string, pathPattern: RegExp, failure: CannedFailure, method?: string): void;
  /** Seeds an existing contact/customer/client, as the vendor would already have it. */
  seedExisting(
    vendor: "hubspot" | "gohighlevel" | "jobber" | "housecall_pro",
    email: string,
  ): string;
  /** Answers every request with a network error (the vendor is unreachable). */
  setOffline(offline: boolean): void;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function parseBody(raw: string, contentType: string): unknown {
  if (raw.length === 0) return null;
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

type Body = Record<string, unknown>;

export function createFakeCrms(): FakeCrms {
  const requests: RecordedRequest[] = [];
  const failures: {
    host: string;
    pattern: RegExp;
    method: string | null;
    failure: CannedFailure;
  }[] = [];
  let offline = false;
  let counter = 1000;
  const nextId = () => String((counter += 1));

  const hubspot = {
    contacts: new Map<string, Body>(),
    notes: new Map<string, Body>(),
  };
  const ghl = { contacts: new Map<string, Body>(), notes: new Map<string, Body>() };
  const jobber = { clients: new Map<string, Body>(), requests: new Map<string, Body>() };
  const hcp = { customers: new Map<string, Body>(), leads: new Map<string, Body>() };
  const servicetitan = { bookings: new Map<string, Body>() };

  function hubspotRoute(request: RecordedRequest): Response {
    const path = request.url.pathname;
    const body = (request.body ?? {}) as Body;
    if (request.method === "POST" && path === "/oauth/v3/token") {
      return json(200, {
        token_type: "bearer",
        access_token: `hs-access-${nextId()}`,
        refresh_token: "hs-refresh-rotated",
        expires_in: 1800,
        hub_id: 4242,
      });
    }
    if (request.method === "GET" && path === "/account-info/v3/details") {
      return json(200, { portalId: 4242, accountType: "STANDARD", timeZone: "US/Central" });
    }
    if (request.method === "POST" && path === "/crm/v3/objects/contacts/search") {
      const filter = ((body["filterGroups"] as Body[])[0]!["filters"] as Body[])[0]!;
      const found = [...hubspot.contacts.entries()].filter(
        ([, contact]) =>
          (contact["properties"] as Body)[String(filter["propertyName"])] === filter["value"],
      );
      return json(200, {
        total: found.length,
        results: found.slice(0, 1).map(([id, contact]) => ({ id, ...contact })),
      });
    }
    if (request.method === "POST" && path === "/crm/v3/objects/contacts") {
      const props = body["properties"] as Body;
      const clash = [...hubspot.contacts.entries()].find(
        ([, c]) =>
          props["email"] !== undefined && (c["properties"] as Body)["email"] === props["email"],
      );
      if (clash !== undefined) {
        return json(409, {
          status: "error",
          message: `Contact already exists. Existing ID: ${clash[0]}`,
          category: "CONFLICT",
        });
      }
      const id = nextId();
      hubspot.contacts.set(id, { properties: props });
      return json(201, {
        id,
        properties: props,
        createdAt: "2026-11-12T15:00:00Z",
        archived: false,
      });
    }
    const contact = /^\/crm\/v3\/objects\/contacts\/(\d+)$/.exec(path);
    if (request.method === "PATCH" && contact !== null) {
      const existing = hubspot.contacts.get(contact[1]!);
      if (existing === undefined)
        return json(404, { status: "error", message: "resource not found" });
      existing["properties"] = {
        ...(existing["properties"] as Body),
        ...(body["properties"] as Body),
      };
      return json(200, { id: contact[1], ...existing });
    }
    if (request.method === "POST" && path === "/crm/v3/objects/notes") {
      const id = nextId();
      hubspot.notes.set(id, body);
      return json(201, { id, properties: body["properties"] });
    }
    const note = /^\/crm\/v3\/objects\/notes\/(\d+)$/.exec(path);
    if (request.method === "PATCH" && note !== null) {
      if (!hubspot.notes.has(note[1]!)) return json(404, { status: "error", message: "not found" });
      hubspot.notes.set(note[1]!, body);
      return json(200, { id: note[1], properties: body["properties"] });
    }
    return json(404, { status: "error", message: `No route ${request.method} ${path}` });
  }

  function ghlRoute(request: RecordedRequest): Response {
    const path = request.url.pathname;
    const body = (request.body ?? {}) as Body;
    if (request.method === "POST" && path === "/oauth/token") {
      return json(200, {
        access_token: `ghl-access-${nextId()}`,
        token_type: "Bearer",
        expires_in: 86399,
        refresh_token: `ghl-refresh-${nextId()}`,
        scope: "contacts.write contacts.readonly",
        userType: "Location",
        locationId: "loc_123",
        companyId: "comp_9",
      });
    }
    const location = /^\/locations\/([^/]+)$/.exec(path);
    if (request.method === "GET" && location !== null) {
      return json(200, {
        location: { id: decodeURIComponent(location[1]!), name: "Summit Roofing" },
      });
    }
    if (request.method === "POST" && (path === "/contacts/upsert" || path === "/contacts/")) {
      const match =
        path === "/contacts/upsert" && body["createNewIfDuplicateAllowed"] !== true
          ? [...ghl.contacts.entries()].find(
              ([, c]) =>
                (body["email"] !== undefined && c["email"] === body["email"]) ||
                (body["phone"] !== undefined && c["phone"] === body["phone"]),
            )
          : undefined;
      if (match !== undefined) {
        Object.assign(match[1], body);
        return json(200, { new: false, contact: { id: match[0], ...match[1] }, traceId: "t-1" });
      }
      const id = `ghl_${nextId()}`;
      ghl.contacts.set(id, { ...body });
      return json(201, { new: true, contact: { id, ...body }, traceId: "t-2" });
    }
    const contactNotes = /^\/contacts\/([^/]+)\/notes$/.exec(path);
    if (request.method === "POST" && contactNotes !== null) {
      const id = `note_${nextId()}`;
      ghl.notes.set(id, body);
      return json(201, {
        note: {
          id,
          body: body["body"],
          contactId: contactNotes[1],
          dateAdded: "2026-11-12T15:00:00Z",
        },
      });
    }
    const noteEdit = /^\/contacts\/([^/]+)\/notes\/([^/]+)$/.exec(path);
    if (request.method === "PUT" && noteEdit !== null) {
      if (!ghl.notes.has(noteEdit[2]!)) return json(404, { message: "Note not found" });
      ghl.notes.set(noteEdit[2]!, body);
      return json(200, { note: { id: noteEdit[2], body: body["body"] } });
    }
    const contact = /^\/contacts\/([^/]+)$/.exec(path);
    if (request.method === "PUT" && contact !== null) {
      const existing = ghl.contacts.get(contact[1]!);
      if (existing === undefined) return json(404, { message: "Contact not found" });
      Object.assign(existing, body);
      return json(200, { succeded: true, contact: { id: contact[1], ...existing } });
    }
    if (request.method === "POST" && path === "/opportunities/") {
      return json(201, { opportunity: { id: `opp_${nextId()}`, ...body } });
    }
    return json(404, { message: `No route ${request.method} ${path}` });
  }

  function jobberRoute(request: RecordedRequest): Response {
    const path = request.url.pathname;
    if (request.method === "POST" && path === "/api/oauth/token") {
      return json(200, {
        access_token: `jobber-access-${nextId()}`,
        refresh_token: `jobber-refresh-${nextId()}`,
        expires_in: 3600,
      });
    }
    if (request.method !== "POST" || path !== "/api/graphql") {
      return json(404, { errors: [{ message: "Not found" }] });
    }
    const body = request.body as { query: string; variables: Body };
    const query = body.query;
    const variables = body.variables;
    const extensions = {
      cost: {
        requestedQueryCost: 12,
        actualQueryCost: 12,
        throttleStatus: { maximumAvailable: 10000, currentlyAvailable: 9988, restoreRate: 500 },
      },
    };
    if (query.includes("account {")) {
      return json(200, {
        data: { account: { id: "acc_1", name: "Summit Roofing LLC" } },
        extensions,
      });
    }
    if (query.includes("clients(searchTerm")) {
      const term = String(variables["term"]);
      const found = [...jobber.clients.entries()].filter(([, client]) =>
        JSON.stringify(client).includes(term),
      );
      const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
      return json(200, {
        data: {
          clients: {
            nodes: found.slice(0, 5).map(([id, client]) => ({
              id,
              emails: list<Body>(client["emails"]).map((e) => ({ address: e["address"] })),
              phones: list<Body>(client["phones"]).map((p) => ({ number: p["number"] })),
            })),
          },
        },
        extensions,
      });
    }
    if (query.includes("requests(filter")) {
      const clientId = String(variables["clientId"]);
      const found = [...jobber.requests.entries()].filter(
        ([, request]) => request["clientId"] === clientId,
      );
      return json(200, {
        data: {
          requests: {
            nodes: found.map(([id, request]) => ({
              id,
              title: request["title"] ?? null,
              jobberWebUri: `https://secure.getjobber.com/requests/${id}`,
            })),
          },
        },
        extensions,
      });
    }
    if (query.includes("clientCreate(")) {
      const id = `Z2lkOi8vSm9iYmVyL0NsaWVudC8${nextId()}`;
      jobber.clients.set(id, variables["input"] as Body);
      return json(200, {
        data: {
          clientCreate: {
            client: { id, jobberWebUri: `https://secure.getjobber.com/clients/${id}` },
            userErrors: [],
          },
        },
        extensions,
      });
    }
    if (query.includes("clientEdit(")) {
      const id = String(variables["clientId"]);
      const client = jobber.clients.get(id);
      if (client === undefined) {
        return json(200, {
          data: {
            clientEdit: {
              client: null,
              userErrors: [{ message: "Client not found", path: ["clientId"] }],
            },
          },
        });
      }
      Object.assign(client, variables["input"] as Body);
      return json(200, { data: { clientEdit: { client: { id }, userErrors: [] } }, extensions });
    }
    if (query.includes("requestCreate(")) {
      const id = `Z2lkOi8vSm9iYmVyL1JlcXVlc3Qv${nextId()}`;
      jobber.requests.set(id, variables["input"] as Body);
      return json(200, {
        data: {
          requestCreate: {
            request: { id, jobberWebUri: `https://secure.getjobber.com/requests/${id}` },
            userErrors: [],
          },
        },
        extensions,
      });
    }
    if (query.includes("clientCreateNote(")) {
      return json(200, {
        data: { clientCreateNote: { clientNote: { id: `note_${nextId()}` }, userErrors: [] } },
        extensions,
      });
    }
    return json(200, { errors: [{ message: "Unknown operation" }] });
  }

  function hcpRoute(request: RecordedRequest): Response {
    const path = request.url.pathname;
    const body = (request.body ?? {}) as Body;
    if (request.method === "GET" && path === "/company") {
      return json(200, {
        id: "cmp_1",
        name: "Summit Roofing",
        support_email: "office@summit.example",
      });
    }
    if (request.method === "GET" && path === "/customers") {
      const q = request.url.searchParams.get("q") ?? "";
      const found = [...hcp.customers.entries()].filter(
        ([, customer]) => customer["email"] === q || customer["mobile_number"] === q,
      );
      return json(200, {
        page: 1,
        page_size: 1,
        total_pages: found.length,
        total_items: found.length,
        customers: found.slice(0, 1).map(([id, customer]) => ({ id, ...customer })),
      });
    }
    if (request.method === "POST" && path === "/customers") {
      const id = `cus_${nextId()}`;
      const addresses = ((body["addresses"] as Body[] | undefined) ?? []).map((address) => ({
        id: `adr_${nextId()}`,
        ...address,
      }));
      hcp.customers.set(id, { ...body, addresses });
      return json(201, { id, ...body, addresses });
    }
    const customer = /^\/customers\/([^/]+)$/.exec(path);
    if (request.method === "PUT" && customer !== null) {
      const existing = hcp.customers.get(customer[1]!);
      if (existing === undefined) return json(404, { error: { message: "Customer not found" } });
      Object.assign(existing, body);
      return json(200, { id: customer[1], ...existing });
    }
    if (request.method === "POST" && path === "/leads") {
      const id = `lea_${nextId()}`;
      hcp.leads.set(id, { ...body, status: "open" });
      return json(201, { id, ...body, status: "open" });
    }
    if (request.method === "GET" && path === "/leads") {
      const customerId = request.url.searchParams.get("customer_id");
      const found = [...hcp.leads.entries()]
        .filter(([, lead]) => customerId === null || lead["customer_id"] === customerId)
        .reverse();
      return json(200, {
        page: 1,
        page_size: 10,
        total_pages: 1,
        total_items: found.length,
        leads: found.slice(0, 10).map(([id, lead]) => ({
          id,
          status: lead["status"],
          lead_source: lead["lead_source"],
          customer: { id: lead["customer_id"] },
        })),
      });
    }
    return json(404, { error: { message: `No route ${request.method} ${path}` } });
  }

  function servicetitanRoute(request: RecordedRequest): Response {
    const path = request.url.pathname;
    const body = (request.body ?? {}) as Body;
    if (request.method === "POST" && path === "/connect/token") {
      return json(200, {
        access_token: `st-access-${nextId()}`,
        expires_in: 900,
        token_type: "Bearer",
        scope: "tn.crm.bookings",
      });
    }
    const list = /^\/crm\/v2\/tenant\/(\d+)\/booking-provider\/(\d+)\/bookings$/.exec(path);
    if (list !== null && request.method === "GET") {
      const externalId = request.url.searchParams.get("externalId");
      const found = [...servicetitan.bookings.entries()]
        .filter(([, booking]) => externalId !== null && booking["externalId"] === externalId)
        .map(([id, booking]) => ({ id: Number(id), ...booking }));
      return json(200, { page: 1, pageSize: 1, hasMore: false, data: found.slice(0, 1) });
    }
    if (list !== null && request.method === "POST") {
      const id = Number(nextId()) * 10;
      servicetitan.bookings.set(String(id), body);
      return json(200, { id, ...body, status: "Pending", createdOn: "2026-11-12T15:00:00Z" });
    }
    const one = /^\/crm\/v2\/tenant\/(\d+)\/booking-provider\/(\d+)\/bookings\/(\d+)$/.exec(path);
    if (one !== null && request.method === "PATCH") {
      const existing = servicetitan.bookings.get(one[3]!);
      if (existing === undefined)
        return json(404, { type: "NotFound", title: "Booking not found", status: 404 });
      Object.assign(existing, body);
      return json(200, { id: Number(one[3]), ...existing });
    }
    return json(404, { title: `No route ${request.method} ${path}`, status: 404 });
  }

  const routes: Record<string, (request: RecordedRequest) => Response> = {
    "api.hubapi.com": hubspotRoute,
    "services.leadconnectorhq.com": ghlRoute,
    "api.getjobber.com": jobberRoute,
    "api.housecallpro.com": hcpRoute,
    "api-integration.servicetitan.io": servicetitanRoute,
    "auth-integration.servicetitan.io": servicetitanRoute,
    "api.servicetitan.io": servicetitanRoute,
    "auth.servicetitan.io": servicetitanRoute,
  };

  const fakeFetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const rawBody = typeof init?.body === "string" ? init.body : "";
    const request: RecordedRequest = {
      method: (init?.method ?? "GET").toUpperCase(),
      url,
      headers,
      body: parseBody(rawBody, headers["content-type"] ?? ""),
      rawBody,
    };
    requests.push(request);
    if (offline) throw new TypeError("fetch failed");
    const index = failures.findIndex(
      (f) =>
        f.host === url.hostname &&
        f.pattern.test(url.pathname) &&
        (f.method === null || f.method === request.method),
    );
    if (index >= 0) {
      const [failure] = failures.splice(index, 1);
      return json(failure!.failure.status, failure!.failure.body, { ...failure!.failure.headers });
    }
    const route = routes[url.hostname];
    if (route === undefined) throw new TypeError(`No fake for ${url.hostname}`);
    return route(request);
  };

  return {
    fetch: fakeFetch,
    requests,
    requestsTo: (host, pattern) =>
      requests.filter(
        (request) =>
          request.url.hostname === host &&
          (pattern === undefined || pattern.test(request.url.pathname)),
      ),
    failNext(host, pattern, failure, method) {
      failures.push({ host, pattern, method: method ?? null, failure });
    },
    seedExisting(vendor, email) {
      const id = nextId();
      if (vendor === "hubspot") hubspot.contacts.set(id, { properties: { email } });
      if (vendor === "gohighlevel") ghl.contacts.set(`ghl_${id}`, { email });
      if (vendor === "jobber") jobber.clients.set(`client_${id}`, { emails: [{ address: email }] });
      if (vendor === "housecall_pro") hcp.customers.set(`cus_${id}`, { email });
      return vendor === "gohighlevel"
        ? `ghl_${id}`
        : vendor === "jobber"
          ? `client_${id}`
          : vendor === "housecall_pro"
            ? `cus_${id}`
            : id;
    },
    setOffline(value) {
      offline = value;
    },
  };
}
