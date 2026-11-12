import { z } from "zod";

import { ValidationError } from "@repo/core";

import { MAX_RAW_MESSAGE_BYTES } from "../mime/parse";
import { apiJson, apiRequest, base64Url, type FetchLike, fromBase64Url } from "./http";

/*
 * The Gmail API (gmail.googleapis.com/gmail/v1), read 2026-11-12: `users.getProfile`,
 * `users.watch` (Pub/Sub topic, label filter, renew at least every 7 days, Google recommends
 * daily), `users.history.list` (`startHistoryId`; 404 when it is too old, then a full sync),
 * `users.messages.list`, `users.messages.get` with `format=raw` (the whole RFC 5322 message,
 * base64url) and `users.messages.send` (`raw` plus `threadId` to stay in the thread).
 */

export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

const Profile = z.object({
  emailAddress: z.string(),
  historyId: z.union([z.string(), z.number()]).transform(String),
});

const Watch = z.object({
  historyId: z.union([z.string(), z.number()]).transform(String),
  expiration: z.union([z.string(), z.number()]).transform(String),
});

const MessageRef = z.object({
  id: z.string(),
  threadId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
});

const History = z.object({
  history: z
    .array(
      z
        .object({
          id: z.union([z.string(), z.number()]).transform(String),
          messagesAdded: z.array(z.object({ message: MessageRef })).optional(),
        })
        .passthrough(),
    )
    .optional(),
  nextPageToken: z.string().optional(),
  historyId: z.union([z.string(), z.number()]).transform(String),
});

const MessageList = z.object({
  messages: z.array(MessageRef).optional(),
  nextPageToken: z.string().optional(),
});

const RawMessage = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).optional(),
  raw: z.string(),
  sizeEstimate: z.number().optional(),
  internalDate: z.union([z.string(), z.number()]).transform(String).optional(),
});

const Sent = z.object({ id: z.string(), threadId: z.string().optional() }).passthrough();

export type GmailMessageRef = z.infer<typeof MessageRef>;

export interface GmailRawMessage {
  readonly id: string;
  readonly threadId: string;
  readonly labelIds: readonly string[];
  readonly raw: Uint8Array;
  readonly internalDate: string | null;
}

export interface GmailClient {
  profile(token: string): Promise<z.infer<typeof Profile>>;
  watch(token: string, topicName: string): Promise<z.infer<typeof Watch>>;
  stop(token: string): Promise<void>;
  history(
    token: string,
    input: { readonly startHistoryId: string; readonly pageToken?: string | null },
  ): Promise<z.infer<typeof History>>;
  list(
    token: string,
    input: {
      readonly q: string;
      readonly labelIds: readonly string[];
      readonly pageToken?: string | null;
    },
  ): Promise<z.infer<typeof MessageList>>;
  raw(token: string, id: string): Promise<GmailRawMessage>;
  send(
    token: string,
    input: { readonly raw: Uint8Array; readonly threadId: string | null },
  ): Promise<{ readonly id: string; readonly threadId: string | null }>;
}

export function createGmailClient(fetchImpl: FetchLike): GmailClient {
  return {
    profile: (token) =>
      apiJson(fetchImpl, "gmail", { method: "GET", url: `${GMAIL_API}/profile`, token }, Profile),

    watch: (token, topicName) =>
      apiJson(
        fetchImpl,
        "gmail",
        {
          method: "POST",
          url: `${GMAIL_API}/watch`,
          token,
          // INBOX for customers' mail, SENT for replies a person writes from the mailbox.
          json: { topicName, labelIds: ["INBOX", "SENT"], labelFilterBehavior: "INCLUDE" },
        },
        Watch,
      ),

    async stop(token) {
      await apiRequest(fetchImpl, "gmail", { method: "POST", url: `${GMAIL_API}/stop`, token });
    },

    history(token, input) {
      const url = new URL(`${GMAIL_API}/history`);
      url.searchParams.set("startHistoryId", input.startHistoryId);
      url.searchParams.set("historyTypes", "messageAdded");
      url.searchParams.set("maxResults", "100");
      if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);
      return apiJson(fetchImpl, "gmail", { method: "GET", url: url.toString(), token }, History);
    },

    list(token, input) {
      const url = new URL(`${GMAIL_API}/messages`);
      url.searchParams.set("q", input.q);
      url.searchParams.set("maxResults", "100");
      for (const label of input.labelIds) url.searchParams.append("labelIds", label);
      if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);
      return apiJson(
        fetchImpl,
        "gmail",
        { method: "GET", url: url.toString(), token },
        MessageList,
      );
    },

    async raw(token, id) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ValidationError("Not a Gmail message id.");
      const message = await apiJson(
        fetchImpl,
        "gmail",
        { method: "GET", url: `${GMAIL_API}/messages/${id}?format=raw`, token, timeoutMs: 60_000 },
        RawMessage,
      );
      const raw = fromBase64Url(message.raw);
      if (raw.byteLength > MAX_RAW_MESSAGE_BYTES) {
        throw new ValidationError("The email is too large to read.");
      }
      return {
        id: message.id,
        threadId: message.threadId,
        labelIds: message.labelIds ?? [],
        raw,
        internalDate: message.internalDate ?? null,
      };
    },

    async send(token, input) {
      const sent = await apiJson(
        fetchImpl,
        "gmail",
        {
          method: "POST",
          url: `${GMAIL_API}/messages/send`,
          token,
          json: {
            raw: base64Url(input.raw),
            ...(input.threadId === null ? {} : { threadId: input.threadId }),
          },
          timeoutMs: 60_000,
        },
        Sent,
      );
      return { id: sent.id, threadId: sent.threadId ?? null };
    },
  };
}
