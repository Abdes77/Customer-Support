import type { FetchLike } from "@repo/channel-meta";

import {
  FIXTURE_IG_ACCOUNT_ID,
  FIXTURE_IG_USERNAME,
  FIXTURE_PAGE_ID,
  FIXTURE_PAGE_NAME,
} from "./fixtures";

/**
 * A stand-in for graph.facebook.com and Meta's CDN, answering the calls the Messenger and
 * Instagram channels make the way the documentation shows. Tests read `calls` and can make
 * the next matching call fail with a Graph error (`failNext`).
 */

export interface FakeGraphCall {
  readonly method: string;
  readonly url: URL;
  /** The path without the version: "/682498171943165/messages". */
  readonly path: string;
  readonly token: string | null;
  readonly json: unknown;
  readonly form: FormData | null;
  readonly failed: boolean;
}

export interface FakePage {
  id: string;
  name: string;
  access_token: string;
  tasks: string[];
  instagram_business_account?: { id: string; username?: string };
}

export interface FakeMetaGraph {
  readonly fetch: FetchLike;
  readonly calls: FakeGraphCall[];
  /** The Pages `/me/accounts` lists (the ones the person granted in Facebook Login). */
  readonly pages: FakePage[];
  failNext(
    match: RegExp,
    error: { code: number; subcode?: number; status?: number; method?: string },
  ): void;
  /** Send API calls that sent a message (not sender actions). */
  sent(): Record<string, unknown>[];
  /** Sender actions (typing, mark_seen). */
  actions(): Record<string, unknown>[];
}

export function createFakeMetaGraph(
  options: {
    /** What the code exchange returns; `expiresIn` makes it a short-lived user token. */
    readonly userToken?: string;
    readonly expiresIn?: number;
    readonly mediaBytes?: Uint8Array;
  } = {},
): FakeMetaGraph {
  const calls: FakeGraphCall[] = [];
  const failures: {
    match: RegExp;
    method?: string;
    code: number;
    subcode?: number;
    status: number;
  }[] = [];
  const pages: FakePage[] = [
    {
      id: FIXTURE_PAGE_ID,
      name: FIXTURE_PAGE_NAME,
      access_token: "EAAPage-token",
      tasks: ["ADVERTISE", "ANALYZE", "CREATE_CONTENT", "MESSAGING", "MODERATE", "MANAGE"],
      instagram_business_account: { id: FIXTURE_IG_ACCOUNT_ID, username: FIXTURE_IG_USERNAME },
    },
  ];
  let sentCount = 0;
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
    calls.push({
      method,
      url,
      path,
      token: auth?.replace(/^Bearer /, "") ?? null,
      json,
      form,
      failed: failure >= 0,
    });
    if (failure >= 0) {
      const [item] = failures.splice(failure, 1);
      return Response.json(
        {
          error: {
            message: `(#${item!.code}) Test failure`,
            type: "OAuthException",
            code: item!.code,
            ...(item!.subcode === undefined ? {} : { error_subcode: item!.subcode }),
            fbtrace_id: "FAKE",
          },
        },
        { status: item!.status },
      );
    }

    if (url.hostname !== "graph.facebook.com") {
      return new Response(mediaBytes.slice(), { headers: { "content-type": "image/jpeg" } });
    }
    if (path === "/oauth/access_token") {
      if (url.searchParams.get("grant_type") === "fb_exchange_token") {
        return Response.json({
          access_token: "EAALong-lived-user-token",
          token_type: "bearer",
          expires_in: 5_183_944,
        });
      }
      return Response.json({
        access_token: options.userToken ?? "EAABusiness-token",
        token_type: "bearer",
        ...(options.expiresIn === undefined ? {} : { expires_in: options.expiresIn }),
      });
    }
    if (path === "/me/accounts") {
      return Response.json({ data: pages, paging: { cursors: { before: "a", after: "b" } } });
    }
    if (/^\/\d+\/subscribed_apps$/.test(path)) return Response.json({ success: true });
    if (/^\/\d+\/message_attachments$/.test(path) && method === "POST") {
      return Response.json({ attachment_id: `att-${calls.length}` });
    }
    if (/^\/\d+\/messages$/.test(path) && method === "POST") {
      const payload = json as Record<string, unknown>;
      const recipient = (payload["recipient"] as { id: string }).id;
      if (payload["sender_action"] !== undefined) return Response.json({ recipient_id: recipient });
      sentCount += 1;
      return Response.json({ recipient_id: recipient, message_id: `m_SENT-${sentCount}` });
    }
    return Response.json(
      { error: { message: `Unknown path ${path}`, code: 100, type: "GraphMethodException" } },
      { status: 400 },
    );
  };

  const messageCalls = () =>
    calls
      .filter((call) => call.path.endsWith("/messages") && call.method === "POST" && !call.failed)
      .map((call) => call.json as Record<string, unknown>);

  return {
    fetch,
    calls,
    pages,
    failNext(match, error) {
      failures.push({
        match,
        code: error.code,
        status: error.status ?? 400,
        ...(error.subcode === undefined ? {} : { subcode: error.subcode }),
        ...(error.method === undefined ? {} : { method: error.method }),
      });
    },
    sent: () => messageCalls().filter((json) => json["sender_action"] === undefined),
    actions: () => messageCalls().filter((json) => json["sender_action"] !== undefined),
  };
}
