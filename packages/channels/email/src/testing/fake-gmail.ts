import { parseEmail } from "../mime/parse";
import { withRewrittenHeaders } from "./fixtures";

/*
 * A fake of the Gmail API and Google's OAuth token endpoint, behind an injected `fetch`. It
 * keeps one mailbox: messages with labels, a history log, a watch, and what was sent. Only
 * the calls the email channel makes are implemented, with the documented shapes.
 */

interface StoredMessage {
  readonly id: string;
  readonly threadId: string;
  labelIds: string[];
  readonly raw: string;
  readonly internalDate: number;
}

export interface FakeGmail {
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  readonly address: string;
  /** Delivers a message to the inbox (or to Sent with `label: "SENT"`). Returns the Gmail id. */
  deliver(
    raw: string,
    options?: { readonly label?: "INBOX" | "SENT"; readonly threadId?: string },
  ): string;
  /** What the app sent through `messages.send`, with the parsed headers. */
  readonly sent: { id: string; threadId: string | null; raw: string }[];
  readonly calls: string[];
  historyId(): string;
  /** Forget history before now (the next `history.list` with an older id answers 404). */
  expireHistory(): void;
  watch: { topicName: string; labelIds: string[] } | null;
  /** Access tokens the fake accepts; a refresh issues a new one. */
  readonly tokens: Set<string>;
  refreshes: number;
  /** Answer 401 to everything (a revoked grant). */
  revoked: boolean;
  /** Keep sent mail in SENT with a Message-ID of Gmail's own and without our loop header. */
  rewriteSentHeaders: boolean;
}

function bodyText(init: RequestInit | undefined, fallback = ""): string {
  return typeof init?.body === "string" ? init.body : fallback;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function createFakeGmail(
  options: { readonly address?: string; readonly now?: () => Date } = {},
): FakeGmail {
  const address = options.address ?? "office@acme-roofing.com";
  const now = options.now ?? (() => new Date());
  const messages = new Map<string, StoredMessage>();
  const history: { id: number; messageId: string; threadId: string; labelIds: string[] }[] = [];
  let historyCounter = 1000;
  let historyFloor = 0;
  let idCounter = 1;
  const fake: FakeGmail = {
    address,
    sent: [],
    calls: [],
    watch: null,
    tokens: new Set(["gmail-access-1"]),
    refreshes: 0,
    revoked: false,
    rewriteSentHeaders: false,
    historyId: () => String(historyCounter),
    expireHistory() {
      historyFloor = historyCounter;
    },
    deliver(raw, deliverOptions = {}) {
      const id = `18c${(idCounter++).toString(16).padStart(13, "0")}`;
      const threadId = deliverOptions.threadId ?? id;
      const labelIds = [deliverOptions.label ?? "INBOX", "UNREAD"];
      messages.set(id, { id, threadId, labelIds, raw, internalDate: now().getTime() });
      historyCounter += 1;
      history.push({ id: historyCounter, messageId: id, threadId, labelIds });
      return id;
    },
    fetch: async (input, init) => {
      const url = new URL(input);
      const method = init?.method ?? "GET";
      fake.calls.push(`${method} ${url.pathname}`);
      if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
        const form = new URLSearchParams(bodyText(init));
        if (form.get("grant_type") === "refresh_token") {
          if (fake.revoked)
            return json(400, {
              error: "invalid_grant",
              error_description: "Token has been expired or revoked.",
            });
          fake.refreshes += 1;
          const token = `gmail-access-${fake.refreshes + 1}`;
          fake.tokens.add(token);
          return json(200, {
            access_token: token,
            expires_in: 3599,
            scope:
              "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
            token_type: "Bearer",
          });
        }
        if (form.get("code") === "bad-code") return json(400, { error: "invalid_grant" });
        if (form.get("code_verifier") === null) return json(400, { error: "invalid_request" });
        return json(200, {
          access_token: "gmail-access-1",
          expires_in: 3599,
          refresh_token: "gmail-refresh-1",
          scope:
            form.get("code") === "no-send-scope"
              ? "https://www.googleapis.com/auth/gmail.readonly"
              : "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
          token_type: "Bearer",
        });
      }
      if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/revoke")
        return new Response(null, { status: 200 });
      if (url.hostname !== "gmail.googleapis.com")
        return json(404, { error: { code: 404, message: "unknown host" } });
      const token = /^Bearer (.+)$/.exec(
        new Headers(init?.headers).get("authorization") ?? "",
      )?.[1];
      if (fake.revoked || token === undefined || !fake.tokens.has(token)) {
        return json(401, {
          error: { code: 401, message: "Invalid Credentials", status: "UNAUTHENTICATED" },
        });
      }
      const path = url.pathname.replace("/gmail/v1/users/me", "");
      if (path === "/profile")
        return json(200, {
          emailAddress: address,
          historyId: String(historyCounter),
          messagesTotal: messages.size,
        });
      if (path === "/watch" && method === "POST") {
        const body = JSON.parse(bodyText(init, "{}")) as { topicName: string; labelIds: string[] };
        fake.watch = { topicName: body.topicName, labelIds: body.labelIds };
        return json(200, {
          historyId: String(historyCounter),
          expiration: String(now().getTime() + 7 * 24 * 3600_000),
        });
      }
      if (path === "/stop" && method === "POST") {
        fake.watch = null;
        return new Response(null, { status: 204 });
      }
      if (path === "/history") {
        const start = Number(url.searchParams.get("startHistoryId"));
        if (start < historyFloor)
          return json(404, {
            error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" },
          });
        const records = history
          .filter((record) => record.id > start)
          .map((record) => ({
            id: String(record.id),
            messages: [{ id: record.messageId, threadId: record.threadId }],
            messagesAdded: [
              {
                message: {
                  id: record.messageId,
                  threadId: record.threadId,
                  labelIds: record.labelIds,
                },
              },
            ],
          }));
        return json(200, {
          ...(records.length > 0 ? { history: records } : {}),
          historyId: String(historyCounter),
        });
      }
      if (path === "/messages" && method === "GET") {
        const after =
          Number(/after:(\d+)/.exec(url.searchParams.get("q") ?? "")?.[1] ?? "0") * 1000;
        const labels = url.searchParams.getAll("labelIds");
        const list = [...messages.values()].filter(
          (message) =>
            message.internalDate >= after &&
            labels.every((label) => message.labelIds.includes(label)),
        );
        return json(
          200,
          list.length === 0
            ? { resultSizeEstimate: 0 }
            : { messages: list.map((message) => ({ id: message.id, threadId: message.threadId })) },
        );
      }
      const get = /^\/messages\/([A-Za-z0-9_-]+)$/.exec(path);
      if (get !== null && method === "GET") {
        const message = messages.get(get[1]!);
        if (message === undefined)
          return json(404, { error: { code: 404, message: "Requested entity was not found." } });
        return json(200, {
          id: message.id,
          threadId: message.threadId,
          labelIds: message.labelIds,
          raw: Buffer.from(message.raw).toString("base64url"),
          sizeEstimate: message.raw.length,
          historyId: String(historyCounter),
          internalDate: String(message.internalDate),
        });
      }
      if (path === "/messages/send" && method === "POST") {
        const body = JSON.parse(bodyText(init, "{}")) as { raw: string; threadId?: string };
        const raw = Buffer.from(body.raw, "base64url").toString("utf8");
        await parseEmail(raw);
        const id = fake.deliver(fake.rewriteSentHeaders ? withRewrittenHeaders(raw) : raw, {
          label: "SENT",
          ...(body.threadId === undefined ? {} : { threadId: body.threadId }),
        });
        fake.sent.push({ id, threadId: body.threadId ?? null, raw });
        return json(200, { id, threadId: body.threadId ?? id, labelIds: ["SENT"] });
      }
      return json(404, { error: { code: 404, message: `Not implemented: ${method} ${path}` } });
    },
  };
  return fake;
}
