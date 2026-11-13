import { z } from "zod";

import { ValidationError } from "@repo/core";

import { MAX_RAW_MESSAGE_BYTES } from "../mime/parse";
import { apiJson, apiRequest, type FetchLike, MailProviderError } from "./http";

/*
 * Microsoft Graph v1.0 for Outlook and Microsoft 365 mailboxes, read 2026-11-12:
 * `GET /me`; `message: delta` per folder (`changeType=created`, `$filter=receivedDateTime ge
 * …` so a new connection does not read the whole mailbox, `Prefer: odata.maxpagesize`, the
 * `@odata.nextLink`/`@odata.deltaLink` state URLs); `GET /me/messages/{id}/$value` (the MIME
 * content); `POST /me/sendMail` with the MIME message base64-encoded and
 * `Content-Type: text/plain` (202, no body; the message is saved to Sent Items); and
 * subscriptions (`POST /subscriptions`, renew with `PATCH`, at most 10,080 minutes for
 * Outlook messages).
 */

export const GRAPH_API = "https://graph.microsoft.com/v1.0";

/** Well-known folder names (Graph accepts them in place of folder ids). */
export const GRAPH_FOLDERS = ["inbox", "sentitems"] as const;
export type GraphFolder = (typeof GRAPH_FOLDERS)[number];

const Me = z
  .object({
    id: z.string(),
    mail: z.string().nullable().optional(),
    userPrincipalName: z.string().nullable().optional(),
    displayName: z.string().nullable().optional(),
  })
  .passthrough();

const DeltaItem = z
  .object({
    id: z.string(),
    internetMessageId: z.string().nullable().optional(),
    conversationId: z.string().nullable().optional(),
    receivedDateTime: z.string().nullable().optional(),
    "@removed": z.unknown().optional(),
  })
  .passthrough();

const DeltaPage = z
  .object({
    value: z.array(DeltaItem),
    "@odata.nextLink": z.string().optional(),
    "@odata.deltaLink": z.string().optional(),
  })
  .passthrough();

const Subscription = z.object({ id: z.string(), expirationDateTime: z.string() }).passthrough();

export type GraphDeltaItem = z.infer<typeof DeltaItem>;
export type GraphDeltaPage = z.infer<typeof DeltaPage>;

/** Graph's state URLs carry our query in their token; they must stay on Graph's host. */
function assertGraphUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError("Not a Graph URL.");
  }
  if (url.protocol !== "https:" || url.hostname !== "graph.microsoft.com" || url.port !== "") {
    throw new ValidationError("A Graph state URL points to another host.");
  }
  return url.toString();
}

export interface GraphMailClient {
  me(token: string): Promise<z.infer<typeof Me>>;
  /** The first page of a folder's delta, from `since` on. */
  deltaStart(token: string, folder: GraphFolder, since: Date): Promise<GraphDeltaPage>;
  /** The page behind a stored `@odata.nextLink` or `@odata.deltaLink`. */
  deltaNext(token: string, link: string): Promise<GraphDeltaPage>;
  mime(token: string, id: string): Promise<Uint8Array>;
  sendMime(token: string, raw: Uint8Array): Promise<void>;
  subscribe(
    token: string,
    input: {
      readonly notificationUrl: string;
      readonly clientState: string;
      readonly expiresAt: Date;
    },
  ): Promise<z.infer<typeof Subscription>>;
  renew(token: string, id: string, expiresAt: Date): Promise<z.infer<typeof Subscription>>;
  unsubscribe(token: string, id: string): Promise<void>;
}

const PAGE_SIZE = "odata.maxpagesize=50";
const DELTA_SELECT = "id,internetMessageId,conversationId,receivedDateTime";

export function createGraphMailClient(fetchImpl: FetchLike): GraphMailClient {
  return {
    me: (token) =>
      apiJson(
        fetchImpl,
        "microsoft",
        {
          method: "GET",
          url: `${GRAPH_API}/me?$select=id,mail,userPrincipalName,displayName`,
          token,
        },
        Me,
      ),

    deltaStart(token, folder, since) {
      const url = new URL(`${GRAPH_API}/me/mailFolders/${folder}/messages/delta`);
      url.searchParams.set("changeType", "created");
      url.searchParams.set("$select", DELTA_SELECT);
      url.searchParams.set("$filter", `receivedDateTime ge ${since.toISOString()}`);
      return apiJson(
        fetchImpl,
        "microsoft",
        { method: "GET", url: url.toString(), token, headers: { prefer: PAGE_SIZE } },
        DeltaPage,
      );
    },

    deltaNext(token, link) {
      return apiJson(
        fetchImpl,
        "microsoft",
        { method: "GET", url: assertGraphUrl(link), token, headers: { prefer: PAGE_SIZE } },
        DeltaPage,
      );
    },

    async mime(token, id) {
      if (!/^[A-Za-z0-9_=+/-]{1,512}$/.test(id))
        throw new ValidationError("Not a Graph message id.");
      const response = await apiRequest(fetchImpl, "microsoft", {
        method: "GET",
        url: `${GRAPH_API}/me/messages/${encodeURIComponent(id)}/$value`,
        token,
        headers: { accept: "text/plain, message/rfc822, */*" },
        timeoutMs: 60_000,
      });
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > MAX_RAW_MESSAGE_BYTES)
        throw new ValidationError("The email is too large to read.");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_RAW_MESSAGE_BYTES) {
        throw new ValidationError("The email is too large to read.");
      }
      return bytes;
    },

    async sendMime(token, raw) {
      const response = await apiRequest(fetchImpl, "microsoft", {
        method: "POST",
        url: `${GRAPH_API}/me/sendMail`,
        token,
        headers: { "content-type": "text/plain" },
        body: Buffer.from(raw).toString("base64"),
        timeoutMs: 60_000,
      });
      if (response.status !== 202 && response.status !== 200) {
        throw new MailProviderError(
          "microsoft",
          `Unexpected answer to sendMail (${response.status}).`,
          {
            status: response.status,
            retryable: false,
          },
        );
      }
    },

    subscribe: (token, input) =>
      apiJson(
        fetchImpl,
        "microsoft",
        {
          method: "POST",
          url: `${GRAPH_API}/subscriptions`,
          token,
          json: {
            changeType: "created",
            notificationUrl: input.notificationUrl,
            lifecycleNotificationUrl: input.notificationUrl,
            resource: "me/messages",
            expirationDateTime: input.expiresAt.toISOString(),
            clientState: input.clientState,
          },
        },
        Subscription,
      ),

    renew: (token, id, expiresAt) =>
      apiJson(
        fetchImpl,
        "microsoft",
        {
          method: "PATCH",
          url: `${GRAPH_API}/subscriptions/${encodeURIComponent(id)}`,
          token,
          json: { expirationDateTime: expiresAt.toISOString() },
        },
        Subscription,
      ),

    async unsubscribe(token, id) {
      await apiRequest(fetchImpl, "microsoft", {
        method: "DELETE",
        url: `${GRAPH_API}/subscriptions/${encodeURIComponent(id)}`,
        token,
      });
    },
  };
}
