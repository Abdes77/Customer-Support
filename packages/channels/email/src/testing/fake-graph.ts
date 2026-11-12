import { parseEmail } from "../mime/parse";
import { withRewrittenHeaders } from "./fixtures";

/*
 * A fake of Microsoft Graph's mail API and the Microsoft identity platform's token endpoint,
 * behind an injected `fetch`: one mailbox with an inbox and Sent Items, `message: delta`
 * with paging and delta tokens, the MIME content, MIME `sendMail`, subscriptions and `/me`.
 */

interface StoredMessage {
  readonly seq: number;
  readonly id: string;
  readonly folder: "inbox" | "sentitems";
  readonly conversationId: string;
  readonly receivedDateTime: string;
  readonly internetMessageId: string | null;
  readonly mime: string;
}

export interface FakeGraph {
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  readonly address: string;
  deliver(
    raw: string,
    options?: {
      readonly folder?: "inbox" | "sentitems";
      readonly conversationId?: string;
      readonly at?: Date;
    },
  ): Promise<string>;
  readonly sent: string[];
  readonly subscriptions: Map<
    string,
    { resource: string; notificationUrl: string; clientState: string; expirationDateTime: string }
  >;
  readonly calls: string[];
  /** Answer 410 to the next delta call that uses a delta token. */
  expireDeltaTokens: boolean;
  /** Keep sent mail in Sent Items with a Message-ID of Exchange's own and no loop header. */
  rewriteSentHeaders: boolean;
  readonly tokens: Set<string>;
  refreshes: number;
  /** Refresh tokens the fake has issued; each refresh replaces the old one. */
  readonly refreshTokens: Set<string>;
}

const BASE = "https://graph.microsoft.com/v1.0";
const PAGE_SIZE = 2;

function bodyText(init: RequestInit | undefined, fallback = ""): string {
  return typeof init?.body === "string" ? init.body : fallback;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function graphError(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

export function createFakeGraph(
  options: { readonly address?: string; readonly now?: () => Date } = {},
): FakeGraph {
  const address = options.address ?? "office@acme-roofing.com";
  const now = options.now ?? (() => new Date());
  const messages: StoredMessage[] = [];
  let seq = 0;
  let subscriptionCounter = 0;
  const fake: FakeGraph = {
    address,
    sent: [],
    calls: [],
    subscriptions: new Map(),
    expireDeltaTokens: false,
    rewriteSentHeaders: false,
    tokens: new Set(["graph-access-1"]),
    refreshes: 0,
    refreshTokens: new Set(["graph-refresh-1"]),
    async deliver(raw, deliverOptions = {}) {
      const parsed = await parseEmail(raw);
      seq += 1;
      const id = `AAMkAG${seq.toString().padStart(6, "0")}==`;
      messages.push({
        seq,
        id,
        folder: deliverOptions.folder ?? "inbox",
        conversationId: deliverOptions.conversationId ?? `AAQkConv${seq}`,
        receivedDateTime: (deliverOptions.at ?? now()).toISOString(),
        internetMessageId: parsed.messageId,
        mime: raw,
      });
      return id;
    },
    fetch: async (input, init) => {
      const url = new URL(input);
      const method = init?.method ?? "GET";
      fake.calls.push(`${method} ${url.pathname}`);
      if (url.hostname === "login.microsoftonline.com") {
        const form = new URLSearchParams(bodyText(init));
        if (form.get("grant_type") === "refresh_token") {
          const presented = form.get("refresh_token") ?? "";
          if (!fake.refreshTokens.has(presented))
            return json(400, { error: "invalid_grant", error_description: "AADSTS70000" });
          fake.refreshTokens.delete(presented);
          fake.refreshes += 1;
          const token = `graph-access-${fake.refreshes + 1}`;
          const refresh = `graph-refresh-${fake.refreshes + 1}`;
          fake.tokens.add(token);
          fake.refreshTokens.add(refresh);
          return json(200, {
            access_token: token,
            refresh_token: refresh,
            expires_in: 3600,
            scope: "User.Read Mail.Read Mail.Send",
          });
        }
        if (form.get("code_verifier") === null) return json(400, { error: "invalid_request" });
        return json(200, {
          access_token: "graph-access-1",
          refresh_token: "graph-refresh-1",
          expires_in: 3600,
          scope: "User.Read Mail.Read Mail.Send",
        });
      }
      if (url.hostname !== "graph.microsoft.com")
        return graphError(404, "NotFound", "unknown host");
      const token = /^Bearer (.+)$/.exec(
        new Headers(init?.headers).get("authorization") ?? "",
      )?.[1];
      if (token === undefined || !fake.tokens.has(token))
        return graphError(
          401,
          "InvalidAuthenticationToken",
          "Access token has expired or is not yet valid.",
        );
      const path = url.pathname.replace("/v1.0", "");
      if (path === "/me")
        return json(200, {
          id: "user-object-id-1",
          mail: address,
          userPrincipalName: address,
          displayName: "Acme Roofing Office",
        });

      const delta = /^\/me\/mailFolders\/(inbox|sentitems)\/messages\/delta$/.exec(path);
      if (delta !== null) {
        const folder = delta[1] as "inbox" | "sentitems";
        const deltaToken = url.searchParams.get("$deltatoken");
        const skipToken = url.searchParams.get("$skiptoken");
        if (deltaToken !== null && fake.expireDeltaTokens) {
          fake.expireDeltaTokens = false;
          return graphError(410, "SyncStateNotFound", "The sync state generation is not found.");
        }
        let after: number;
        let since = 0;
        if (deltaToken !== null) after = Number(deltaToken);
        else if (skipToken !== null) {
          const [afterText, sinceText] = skipToken.split("_");
          after = Number(afterText);
          since = Number(sinceText);
        } else {
          after = 0;
          const filter = /receivedDateTime ge (\S+)/.exec(
            url.searchParams.get("$filter") ?? "",
          )?.[1];
          since = filter === undefined ? 0 : Date.parse(filter);
        }
        const pending = messages.filter(
          (message) =>
            message.folder === folder &&
            message.seq > after &&
            Date.parse(message.receivedDateTime) >= since,
        );
        const page = pending.slice(0, PAGE_SIZE);
        const last =
          page.at(-1)?.seq ??
          Math.max(after, ...messages.filter((m) => m.folder === folder).map((m) => m.seq), 0);
        const base = `${BASE}/me/mailFolders/${folder}/messages/delta`;
        return json(200, {
          value: page.map((message) => ({
            id: message.id,
            internetMessageId: message.internetMessageId,
            conversationId: message.conversationId,
            receivedDateTime: message.receivedDateTime,
          })),
          ...(pending.length > PAGE_SIZE
            ? { "@odata.nextLink": `${base}?$skiptoken=${last}_${since}` }
            : { "@odata.deltaLink": `${base}?$deltatoken=${last}` }),
        });
      }
      const value = /^\/me\/messages\/([^/]+)\/\$value$/.exec(path);
      if (value !== null) {
        const message = messages.find((item) => item.id === decodeURIComponent(value[1]!));
        if (message === undefined)
          return graphError(
            404,
            "ErrorItemNotFound",
            "The specified object was not found in the store.",
          );
        return new Response(message.mime, {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      if (path === "/me/sendMail" && method === "POST") {
        if (new Headers(init?.headers).get("content-type") !== "text/plain")
          return graphError(415, "UnsupportedMediaType", "MIME needs text/plain");
        const raw = Buffer.from(bodyText(init), "base64").toString("utf8");
        const parsed = await parseEmail(raw);
        fake.sent.push(raw);
        await fake.deliver(fake.rewriteSentHeaders ? withRewrittenHeaders(raw) : raw, {
          folder: "sentitems",
          conversationId: `AAQkConv-sent-${parsed.messageId ?? "x"}`,
        });
        return new Response(null, { status: 202 });
      }
      if (path === "/subscriptions" && method === "POST") {
        const body = JSON.parse(bodyText(init, "{}")) as {
          resource: string;
          notificationUrl: string;
          clientState: string;
          expirationDateTime: string;
        };
        subscriptionCounter += 1;
        const id = `sub-${subscriptionCounter.toString().padStart(4, "0")}-${Math.random().toString(36).slice(2, 10)}`;
        fake.subscriptions.set(id, body);
        return json(201, { id, ...body });
      }
      const subscription = /^\/subscriptions\/([^/]+)$/.exec(path);
      if (subscription !== null) {
        const id = decodeURIComponent(subscription[1]!);
        const current = fake.subscriptions.get(id);
        if (current === undefined)
          return graphError(404, "ResourceNotFound", "The object was not found.");
        if (method === "DELETE") {
          fake.subscriptions.delete(id);
          return new Response(null, { status: 204 });
        }
        if (method === "PATCH") {
          const body = JSON.parse(bodyText(init, "{}")) as { expirationDateTime: string };
          current.expirationDateTime = body.expirationDateTime;
          return json(200, { id, ...current });
        }
      }
      return graphError(404, "NotImplemented", `${method} ${path}`);
    },
  };
  return fake;
}
