import {
  CHANNEL_CAPABILITIES,
  type ChannelAdapter,
  type ChannelConnectionContext,
  type Logger,
  type OutboundMessage,
  type SendFailure,
  type SendResult,
  type SendTarget,
  ValidationError,
} from "@repo/core";

import { domainOf, normalizeAddress } from "./addresses";
import {
  EmailConnectionConfig,
  EmailCredentials,
  type ImapConfig,
  type PasswordCredentials,
} from "./config";
import { buildEmail, type OutgoingAttachment } from "./mime/build";
import { MailHostError, type MailNetworkPolicy, DEFAULT_MAIL_POLICY } from "./net/resolve";
import type { GmailClient } from "./providers/gmail";
import { MailProviderError } from "./providers/http";
import { MailServerError, openImap, sendSmtp } from "./providers/imap";
import type { GraphMailClient } from "./providers/microsoft";
import { outboundMessageId, replySubject } from "./thread";

/**
 * Reads the file of an outbound attachment from our storage (injected by the app, like the
 * Meta adapters' media reader). The path must be inside the connection's business.
 */
export type EmailMediaReader = (
  connection: ChannelConnectionContext,
  location: { readonly bucket: string; readonly path: string },
) => Promise<{ readonly bytes: Uint8Array; readonly mimeType: string; readonly fileName: string }>;

export interface EmailAdapterDeps {
  /** A valid access token for a Gmail or Microsoft connection (refreshed when needed). */
  readonly accessToken: (connection: ChannelConnectionContext) => Promise<string>;
  readonly gmail: GmailClient;
  readonly graph: GraphMailClient;
  readonly media?: EmailMediaReader;
  readonly mailPolicy?: MailNetworkPolicy;
  readonly clock?: () => Date;
  readonly logger: Logger;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function plainHtml(text: string): string {
  const body = text
    .split(/\n\s*\n/)
    .map((block) => `<div>${escapeHtml(block.trim()).replace(/\n/g, "<br>")}</div>`)
    .join("<div><br></div>");
  return `<div dir="ltr" style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222">${body}</div>`;
}

function failure(
  code: string,
  message: string,
  retryable: boolean,
  retryAfterSeconds: number | null = null,
): SendResult {
  const error: SendFailure = {
    code,
    message: message.slice(0, 500),
    retryable,
    retryAfterSeconds,
    windowClosed: false,
  };
  return { ok: false, error };
}

function asFailure(error: unknown): SendResult {
  if (error instanceof MailHostError)
    return failure("mail_host_refused", error.message, error.retryable);
  if (error instanceof MailProviderError) {
    return failure(
      error.authFailed ? "auth_failed" : (error.providerCode ?? `http_${error.status ?? "error"}`),
      error.message,
      error.retryable,
      error.retryAfterSeconds ?? null,
    );
  }
  if (error instanceof MailServerError) {
    return failure(
      error.authFailed ? "auth_failed" : `${error.provider}_failed`,
      error.message,
      error.retryable,
    );
  }
  if (error instanceof ValidationError) return failure("invalid_message", error.message, false);
  return failure(
    "send_error",
    error instanceof Error ? error.message : "The email could not be sent.",
    true,
  );
}

/** The Gmail thread id inside a conversation's thread key (`gmail:<id>`), if it is one. */
export function gmailThreadOf(externalThreadId: string | null): string | null {
  if (!externalThreadId?.startsWith("gmail:")) return null;
  const id = externalThreadId.slice("gmail:".length);
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}

/**
 * The email channel. Inbound mail does not come through `parseWebhook`: Gmail and Graph
 * notify, IMAP is polled, and the server half (`/server`) fetches the messages and calls the
 * pipeline's `ingest` (ARCHITECTURE §2). `send` turns one outbound message into an RFC 5322
 * email in the customer's thread and sends it with the connection's provider; the provider
 * message id it returns is our Message-ID (Graph's send returns none, and a reply's
 * In-Reply-To names it).
 */
export function createEmailAdapter(deps: EmailAdapterDeps): ChannelAdapter {
  const clock = deps.clock ?? (() => new Date());
  const policy = deps.mailPolicy ?? DEFAULT_MAIL_POLICY;
  const log = deps.logger.child({ component: "email-adapter" });

  async function appendToSent(
    config: ImapConfig,
    credentials: PasswordCredentials,
    raw: Uint8Array,
  ): Promise<void> {
    if (!config.appendSent || config.sentFolder === null) return;
    try {
      const session = await openImap(config.imap, credentials.imapPassword, policy);
      try {
        await session.append(config.sentFolder, raw);
      } finally {
        await session.close();
      }
    } catch (error) {
      // The email went out; a missing copy in Sent is not worth failing the send for.
      log.warn("email.append_sent_failed", {
        error: error instanceof Error ? error.name : "error",
      });
    }
  }

  return {
    channel: "email",
    capabilities: CHANNEL_CAPABILITIES.email,

    async verifyWebhook() {
      return {
        outcome: "rejected",
        reason: "Email arrives through the Gmail and Graph notification routes and IMAP polling.",
      };
    },

    async parseWebhook() {
      throw new ValidationError("Email has no generic webhook.");
    },

    async send(message: OutboundMessage, target: SendTarget): Promise<SendResult> {
      const config = EmailConnectionConfig.safeParse(target.connection.config);
      const credentials = EmailCredentials.safeParse(target.connection.credentials);
      if (!config.success || !credentials.success) {
        return failure(
          "not_connected",
          "The inbox is not connected (missing configuration or credentials).",
          false,
        );
      }
      const inbox = config.data;
      const recipient = normalizeAddress(target.recipientExternalId);
      if (recipient === null)
        return failure("invalid_recipient", "The customer has no valid email address.", false);

      let subject = target.email?.subject ?? replySubject(null);
      let text: string;
      let html: string | null;
      let cc: { address: string; name: string | null }[] = [];
      let fromName = inbox.displayName;
      const attachments: OutgoingAttachment[] = [];
      switch (message.kind) {
        case "email":
          subject = message.subject.trim().length > 0 ? message.subject : subject;
          text = message.text;
          html = message.html.length > 0 ? message.html : plainHtml(message.text);
          cc = (message.cc ?? []).map((item) => ({ address: item.address, name: item.name }));
          fromName = message.fromName ?? fromName;
          break;
        case "text":
          text = message.text;
          html = plainHtml(message.text);
          break;
        case "media": {
          if (deps.media === undefined)
            return failure(
              "media_unavailable",
              "Attachments cannot be sent from this deployment.",
              false,
            );
          try {
            const file = await deps.media(target.connection, message.storage);
            attachments.push({
              fileName: file.fileName,
              mimeType: file.mimeType,
              bytes: file.bytes,
            });
          } catch (error) {
            return failure(
              "media_missing",
              error instanceof Error ? error.message : "The file is missing.",
              false,
            );
          }
          text = message.caption ?? "";
          html = text.length > 0 ? plainHtml(text) : null;
          break;
        }
        case "template":
          return failure("unsupported", "Email has no templates.", false);
      }
      const domain = domainOf(inbox.address) ?? "localhost";
      const messageId = outboundMessageId({
        connectionId: target.connection.connectionId,
        idempotencyKey: target.idempotencyKey,
        domain,
      });
      // Never copy the inbox itself or the customer twice.
      const copied = cc.filter(
        (item) => item.address !== recipient && item.address !== inbox.address,
      );
      let raw: Buffer;
      try {
        raw = await buildEmail({
          from: { address: inbox.address, name: fromName },
          to: [{ address: recipient, name: null }],
          cc: copied,
          subject,
          text,
          html,
          messageId,
          inReplyTo: target.email?.inReplyTo ?? null,
          references: target.email?.references ?? [],
          date: clock(),
          loopToken: inbox.loopToken,
          attachments,
        });
      } catch (error) {
        return asFailure(error);
      }

      // Gmail's own id of the sent copy: recorded with the message, so the copy in Sent is
      // recognized as ours even if Gmail rewrote our Message-ID and loop header.
      let providerMessageId: string | null = null;
      try {
        switch (inbox.provider) {
          case "gmail": {
            const token = await deps.accessToken(target.connection);
            const sent = await deps.gmail.send(token, {
              raw,
              threadId: gmailThreadOf(target.externalThreadId),
            });
            providerMessageId = sent.id;
            break;
          }
          case "microsoft": {
            const token = await deps.accessToken(target.connection);
            await deps.graph.sendMime(token, raw);
            break;
          }
          case "imap": {
            if (credentials.data.kind !== "password") {
              return failure("not_connected", "The inbox has no password stored.", false);
            }
            await sendSmtp(
              inbox.smtp,
              credentials.data.smtpPassword,
              {
                from: inbox.address,
                recipients: [recipient, ...copied.map((item) => item.address)],
                raw,
              },
              policy,
            );
            await appendToSent(inbox, credentials.data, raw);
            break;
          }
        }
      } catch (error) {
        const result = asFailure(error);
        log.warn("email.send_failed", {
          businessId: target.connection.businessId,
          provider: inbox.provider,
          code: result.ok ? null : result.error.code,
        });
        return result;
      }
      return {
        ok: true,
        externalMessageId: messageId,
        sentAt: clock().toISOString(),
        ...(providerMessageId === null ? {} : { providerMessageId }),
      };
    },
  };
}
