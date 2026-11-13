import type { FetchLike } from "@repo/channel-meta";

import { FIXTURE_DISPLAY_NUMBER, FIXTURE_PHONE_NUMBER_ID, FIXTURE_WABA_ID } from "./fixtures";

/**
 * A stand-in for graph.facebook.com and Meta's media host, answering the calls the WhatsApp
 * channel makes the way the documentation shows. Tests read `calls` and can make the next
 * matching call fail with a Graph error (`failNext`).
 */

export interface FakeGraphCall {
  readonly method: string;
  readonly url: URL;
  /** The path without the version: "/106540352242922/messages". */
  readonly path: string;
  readonly token: string | null;
  readonly json: unknown;
  readonly form: FormData | null;
  /** True when the fake answered with an error (`failNext`). */
  readonly failed: boolean;
}

export interface FakeTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  parameter_format?: string;
  components: unknown[];
}

export interface FakeGraph {
  readonly fetch: FetchLike;
  readonly calls: FakeGraphCall[];
  /** Templates the fake WABA holds. */
  readonly templates: FakeTemplate[];
  /** Phone numbers of the fake WABA. */
  readonly phoneNumbers: {
    id: string;
    display_phone_number: string;
    verified_name: string;
    quality_rating?: string;
  }[];
  /** The next call whose path matches (and method, if given) answers with this Graph error. */
  failNext(
    match: RegExp,
    error: { code: number; status?: number; details?: string; method?: string },
  ): void;
  /** Calls to `/{phone}/messages` that sent a message (not read receipts). */
  sent(): Record<string, unknown>[];
  /** Read receipts and typing indicators. */
  receipts(): Record<string, unknown>[];
}

export function createFakeGraph(
  options: { readonly accessToken?: string; readonly mediaBytes?: Uint8Array } = {},
): FakeGraph {
  const calls: FakeGraphCall[] = [];
  const failures: {
    match: RegExp;
    method?: string;
    code: number;
    status: number;
    details?: string;
  }[] = [];
  const templates: FakeTemplate[] = [];
  const phoneNumbers = [
    {
      id: FIXTURE_PHONE_NUMBER_ID,
      display_phone_number: `+1 555-078-3881`,
      verified_name: "Summit Roofing",
      quality_rating: "GREEN",
    },
  ];
  let sentCount = 0;
  let templateCount = 0;
  const mediaBytes = options.mediaBytes ?? new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

  const fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    const auth = headers.get("authorization");
    const path =
      url.hostname === "graph.facebook.com"
        ? url.pathname.replace(/^\/v\d+\.\d+/, "")
        : url.pathname;
    const body = init.body;
    const json = typeof body === "string" ? (JSON.parse(body) as unknown) : null;
    const form = body instanceof FormData ? body : null;
    const method = init.method ?? "GET";
    const failure = failures.findIndex(
      (item) => item.match.test(path) && (item.method === undefined || item.method === method),
    );
    const token = auth?.replace(/^Bearer /, "") ?? null;
    calls.push({ method, url, path, token, json, form, failed: failure >= 0 });
    if (failure >= 0) {
      const [item] = failures.splice(failure, 1);
      return Response.json(
        {
          error: {
            message: `(#${item!.code}) Test failure`,
            type: "OAuthException",
            code: item!.code,
            error_data: { messaging_product: "whatsapp", details: item!.details ?? "Test failure" },
            fbtrace_id: "FAKE",
          },
        },
        { status: item!.status },
      );
    }

    if (url.hostname === "lookaside.fbsbx.com") {
      return new Response(mediaBytes.slice(), {
        headers: { "content-type": "application/octet-stream" },
      });
    }
    if (path === "/oauth/access_token") {
      return Response.json({
        access_token: options.accessToken ?? "EAAG-fake-business-token",
        token_type: "bearer",
      });
    }
    if (/^\/\d+\/messages$/.test(path) && method === "POST") {
      const payload = json as Record<string, unknown>;
      if (payload["status"] === "read") return Response.json({ success: true });
      sentCount += 1;
      const input = (payload["to"] ?? payload["recipient"]) as string;
      return Response.json({
        messaging_product: "whatsapp",
        contacts: [{ input, wa_id: String(input).replace("+", "") }],
        messages: [{ id: `wamid.SENT-${sentCount}` }],
      });
    }
    if (/^\/\d+\/media$/.test(path) && method === "POST") {
      return Response.json({ id: `media-${calls.length}` });
    }
    if (/^\/\d+\/register$/.test(path)) return Response.json({ success: true });
    if (/^\/\d+\/subscribed_apps$/.test(path)) return Response.json({ success: true });
    if (/^\/\d+\/phone_numbers$/.test(path)) {
      return Response.json({
        data: phoneNumbers,
        paging: { cursors: { before: "a", after: "b" } },
      });
    }
    if (/^\/\d+\/message_templates$/.test(path)) {
      if (method === "POST") {
        const payload = json as Record<string, unknown>;
        templateCount += 1;
        const created: FakeTemplate = {
          id: `9000${templateCount}`,
          name: String(payload["name"]),
          language: String(payload["language"]),
          status: "PENDING",
          category: String(payload["category"]).toUpperCase(),
          parameter_format:
            typeof payload["parameter_format"] === "string"
              ? payload["parameter_format"].toUpperCase()
              : "POSITIONAL",
          components: (payload["components"] as unknown[]) ?? [],
        };
        templates.push(created);
        return Response.json({
          id: created.id,
          status: created.status,
          category: created.category,
        });
      }
      if (method === "DELETE") {
        const name = url.searchParams.get("name");
        const index = templates.findIndex((template) => template.name === name);
        if (index >= 0) templates.splice(index, 1);
        return Response.json({ success: true });
      }
      return Response.json({ data: templates, paging: { cursors: { before: "a", after: "b" } } });
    }
    const single = /^\/(\d+)$/.exec(path);
    if (single !== null) {
      const id = single[1]!;
      const number = phoneNumbers.find((item) => item.id === id);
      if (number !== undefined) {
        return Response.json({
          ...number,
          quality_rating: "GREEN",
          code_verification_status: "VERIFIED",
        });
      }
      if (id === FIXTURE_WABA_ID) return Response.json({ id, name: "Summit Roofing" });
      // A media id.
      return Response.json({
        messaging_product: "whatsapp",
        url: `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${id}`,
        mime_type: "image/jpeg",
        sha256: "abc",
        file_size: mediaBytes.byteLength,
        id,
      });
    }
    return Response.json(
      { error: { message: `Unknown path ${path}`, code: 100, type: "GraphMethodException" } },
      { status: 400 },
    );
  };

  return {
    fetch,
    calls,
    templates,
    phoneNumbers,
    failNext(match, error) {
      failures.push({
        match,
        code: error.code,
        status: error.status ?? 400,
        ...(error.details === undefined ? {} : { details: error.details }),
        ...(error.method === undefined ? {} : { method: error.method }),
      });
    },
    sent: () =>
      calls
        .filter((call) => call.path.endsWith("/messages") && call.method === "POST" && !call.failed)
        .map((call) => call.json as Record<string, unknown>)
        .filter((json) => json["status"] !== "read"),
    receipts: () =>
      calls
        .filter((call) => call.path.endsWith("/messages") && call.method === "POST")
        .map((call) => call.json as Record<string, unknown>)
        .filter((json) => json["status"] === "read"),
  };
}

export { FIXTURE_DISPLAY_NUMBER };
