import type {
  AttachmentKind,
  ChannelId,
  ConversationId,
  EmailEnvelope,
  MessagingWindowState,
  OutboundMessage,
} from "@repo/core";
import {
  and,
  type BusinessContext,
  contactIdentities,
  contacts,
  conversations,
  desc,
  eq,
  isNull,
  messages,
  sql,
  takeoverLocks,
} from "@repo/db";

import { type AppSettings } from "@repo/settings";
import { loadSettings } from "@repo/settings/server";

import type { PipelineContext } from "../deps";
import { splitText } from "./split";
import { messagingWindow } from "./window";

/** Where a message goes, without the credentials (those are loaded in the sending step). */
export interface SendTargetInfo {
  readonly channel: ChannelId;
  readonly connectionId: string;
  readonly conversationId: ConversationId;
  readonly recipientExternalId: string;
  readonly externalThreadId: string | null;
  readonly replyToExternalMessageId: string | null;
  readonly window: MessagingWindowState;
  readonly email: Pick<EmailEnvelope, "inReplyTo" | "references" | "subject"> | null;
  readonly sentByHuman: boolean;
}

export type SendPlan =
  | { readonly kind: "done"; readonly reason: string }
  | { readonly kind: "fail"; readonly code: string; readonly message: string }
  | {
      readonly kind: "send";
      readonly parts: readonly OutboundMessage[];
      readonly target: SendTargetInfo;
      readonly author: "bot" | "human_agent";
      /** The message is free-form text or media (a template can replace it). */
      readonly freeForm: boolean;
    }
  | {
      /**
       * The window is closed and the channel has a window fallback: the send step asks it
       * for an approved template that may go out instead (invariant I6).
       */
      readonly kind: "window_closed";
      readonly target: SendTargetInfo;
      readonly author: "bot" | "human_agent";
    };

/**
 * The setting that switches tap-to-answer options on per channel. When it is off, the options
 * are written under the message instead (the contract's fallback for channels without them).
 */
const INTERACTIVE_SETTING: Partial<Record<ChannelId, keyof AppSettings>> = {
  whatsapp: "channels.whatsapp.buttons",
  messenger: "channels.meta.quick_replies",
  instagram: "channels.meta.quick_replies",
};

/** Options as plain lines under the text. */
export function optionsAsText(text: string, options: readonly string[]): string {
  return `${text}\n\n${options.map((option) => `• ${option}`).join("\n")}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Plain text as minimal HTML paragraphs, for an email channel without a composer (tests). */
export function textToHtml(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => `<p>${escapeHtml(paragraph.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * Step "prepare" of a send: the checks that decide whether the message may leave now, and
 * the provider messages it becomes. Bot messages are withheld (marked `superseded`) while a
 * person holds the conversation (invariant I5) or after the customer opted out; a closed
 * messaging window fails the message (C9 adds the template fallback, I6).
 */
export async function prepareSend(
  ctx: BusinessContext,
  p: PipelineContext,
  messageId: string,
): Promise<SendPlan> {
  const now = p.clock();
  const [message] = await ctx.tx
    .select({
      id: messages.id,
      status: messages.status,
      author: messages.author,
      kind: messages.kind,
      text: messages.text,
      payload: messages.payload,
      conversationId: messages.conversationId,
      connectionId: messages.channelConnectionId,
    })
    .from(messages)
    .where(eq(messages.id, messageId as never))
    .limit(1);
  if (message === undefined) return { kind: "done", reason: "not_found" };
  if (message.status !== "sending") return { kind: "done", reason: `status_${message.status}` };

  const [conversation] = await ctx.tx
    .select({
      channel: conversations.channel,
      contactId: conversations.contactId,
      lastInboundAt: conversations.lastInboundAt,
      externalThreadId: conversations.externalThreadId,
      subject: conversations.subject,
    })
    .from(conversations)
    .where(eq(conversations.id, message.conversationId))
    .limit(1);
  if (conversation === undefined) return { kind: "done", reason: "conversation_not_found" };

  const withhold = async (reason: string): Promise<SendPlan> => {
    await ctx.tx
      .update(messages)
      .set({ status: "superseded", errorCode: reason })
      .where(eq(messages.id, message.id));
    p.logger.info("send.withheld", {
      businessId: ctx.tenant.businessId,
      conversationId: message.conversationId,
      messageId: message.id,
      reason,
    });
    return { kind: "done", reason };
  };

  if (message.author === "bot") {
    const [lock] = await ctx.tx
      .select({ id: takeoverLocks.id })
      .from(takeoverLocks)
      .where(
        and(
          eq(takeoverLocks.conversationId, message.conversationId),
          isNull(takeoverLocks.releasedAt),
        ),
      )
      .limit(1);
    if (lock !== undefined) return withhold("takeover");
    const [contact] = await ctx.tx
      .select({ optedOutAt: contacts.optedOutAt, isBlocked: contacts.isBlocked })
      .from(contacts)
      .where(eq(contacts.id, conversation.contactId))
      .limit(1);
    if (contact?.optedOutAt != null) return withhold("opted_out");
    if (contact?.isBlocked === true) return withhold("blocked");
  }

  const adapter = p.adapters.find(conversation.channel);
  if (adapter === undefined) {
    return { kind: "fail", code: "no_adapter", message: "The channel is not available." };
  }
  const sentByHuman = message.author === "human_agent";
  const author = sentByHuman ? "human_agent" : "bot";
  const window = messagingWindow(
    adapter.capabilities,
    conversation.lastInboundAt,
    now,
    sentByHuman,
  );
  const windowClosed = !window.open && message.kind !== "template";
  const hasFallback = p.windowFallbacks.some((item) => item.channel === conversation.channel);
  if (windowClosed && !hasFallback) {
    return {
      kind: "fail",
      code: "window_closed",
      message: "The channel's messaging window is closed for free-form messages.",
    };
  }

  const [identity] = await ctx.tx
    .select({ externalId: contactIdentities.externalId })
    .from(contactIdentities)
    .where(
      and(
        eq(contactIdentities.contactId, conversation.contactId),
        eq(contactIdentities.channel, conversation.channel),
      ),
    )
    .orderBy(sql`${contactIdentities.lastSeenAt} desc nulls last`)
    .limit(1);
  if (identity === undefined) {
    return {
      kind: "fail",
      code: "no_recipient",
      message: "The customer has no address on this channel.",
    };
  }

  const [lastInbound] = await ctx.tx
    .select({ externalMessageId: messages.externalMessageId, payload: messages.payload })
    .from(messages)
    .where(
      and(eq(messages.conversationId, message.conversationId), eq(messages.direction, "inbound")),
    )
    .orderBy(desc(messages.sequence))
    .limit(1);

  const payload = asRecord(message.payload);
  const text = message.text ?? "";

  let email: SendTargetInfo["email"] = null;
  if (conversation.channel === "email") {
    const envelope = asRecord(asRecord(lastInbound?.payload)["email"]);
    const inReplyTo =
      typeof envelope["messageIdHeader"] === "string" ? envelope["messageIdHeader"] : null;
    const subject =
      typeof envelope["subject"] === "string" ? envelope["subject"] : (conversation.subject ?? "");
    email = {
      inReplyTo,
      references: [
        ...stringArray(envelope["references"]),
        ...(inReplyTo === null ? [] : [inReplyTo]),
      ],
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`.trim(),
    };
  }
  // The channel's composer (C11: the business's email) turns text and email messages into
  // what it sends; the subject is the thread's ("Re: …") unless the reply chose a new one.
  const composer = p.outboundComposers.find((item) => item.channel === conversation.channel);
  if (composer !== undefined && (message.kind === "email" || message.kind === "text")) {
    const stored = typeof payload["subject"] === "string" ? payload["subject"].trim() : "";
    const ownSubject =
      message.kind === "email" &&
      stored.length > 0 &&
      stored.toLowerCase() !== (conversation.subject ?? "").trim().toLowerCase();
    const composed = await composer.compose(ctx, {
      messageId: message.id,
      conversationId: message.conversationId,
      author,
      text,
      subject: ownSubject ? stored : (email?.subject ?? stored),
      now,
    });
    const target: SendTargetInfo = {
      channel: conversation.channel,
      connectionId: message.connectionId,
      conversationId: message.conversationId,
      recipientExternalId: identity.externalId,
      externalThreadId: conversation.externalThreadId,
      replyToExternalMessageId: lastInbound?.externalMessageId ?? null,
      window,
      email,
      sentByHuman,
    };
    if (windowClosed) return { kind: "window_closed", target, author };
    return { kind: "send", parts: [composed], target, author, freeForm: true };
  }

  let parts: OutboundMessage[] = [];
  switch (message.kind) {
    case "email": {
      const subject =
        typeof payload["subject"] === "string" ? payload["subject"] : (conversation.subject ?? "");
      parts = [{ kind: "email", subject, text, html: textToHtml(text) }];
      break;
    }
    case "media": {
      const media = asRecord(payload["media"]);
      if (typeof media["bucket"] !== "string" || typeof media["path"] !== "string") {
        return { kind: "fail", code: "invalid_media", message: "The media message has no file." };
      }
      parts = [
        {
          kind: "media",
          mediaKind: (media["mediaKind"] as AttachmentKind | undefined) ?? "image",
          storage: { bucket: media["bucket"], path: media["path"] },
          mimeType:
            typeof media["mimeType"] === "string" ? media["mimeType"] : "application/octet-stream",
          caption: text.length > 0 ? text : null,
        },
      ];
      break;
    }
    case "template": {
      const template = asRecord(payload["template"]);
      if (typeof template["templateName"] !== "string") {
        return {
          kind: "fail",
          code: "invalid_template",
          message: "The template message has no template.",
        };
      }
      const named = asRecord(template["namedVariables"]);
      const namedVariables = Object.fromEntries(
        Object.entries(named).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
      parts = [
        {
          kind: "template",
          templateName: template["templateName"],
          languageCode:
            typeof template["languageCode"] === "string" ? template["languageCode"] : "en_US",
          variables: stringArray(template["variables"]),
          ...(Object.keys(namedVariables).length > 0 ? { namedVariables } : {}),
        },
      ];
      break;
    }
    default: {
      if (windowClosed) break;
      let quickReplies = stringArray(payload["quickReplies"]);
      let body = text;
      const setting = INTERACTIVE_SETTING[conversation.channel];
      if (quickReplies.length > 0 && setting !== undefined) {
        const settings = await loadSettings(ctx, ctx.tenant, { logger: p.logger });
        if (settings.values[setting] === false) {
          body = optionsAsText(text, quickReplies);
          quickReplies = [];
        }
      }
      const chunks = splitText(body, adapter.capabilities.maxTextLength);
      if (chunks.length === 0) return withhold("empty");
      parts = chunks.map((chunk, index) =>
        index === chunks.length - 1 && quickReplies.length > 0
          ? { kind: "text", text: chunk, quickReplies }
          : { kind: "text", text: chunk },
      );
    }
  }

  const target: SendTargetInfo = {
    channel: conversation.channel,
    connectionId: message.connectionId,
    conversationId: message.conversationId,
    recipientExternalId: identity.externalId,
    externalThreadId: conversation.externalThreadId,
    // Chat replies do not quote the customer's message; email threads by its id.
    replyToExternalMessageId:
      conversation.channel === "email" ? (lastInbound?.externalMessageId ?? null) : null,
    window,
    email,
    sentByHuman,
  };
  if (windowClosed) return { kind: "window_closed", target, author };
  return { kind: "send", parts, target, author, freeForm: message.kind !== "template" };
}
