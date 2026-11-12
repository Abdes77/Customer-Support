import PostalMime, { type Address, type Email } from "postal-mime";

import { ValidationError } from "@repo/core";

import { normalizeAddress } from "../addresses";
import { messageIdList, normalizeMessageId } from "../thread";

/** One address of a parsed message, lower case, with its display name. */
export interface ParsedAddress {
  readonly address: string;
  readonly name: string | null;
}

export interface ParsedAttachment {
  readonly fileName: string | null;
  /** Lower case, as the part declared it. */
  readonly mimeType: string;
  readonly disposition: "attachment" | "inline" | null;
  /** Referenced from the HTML by its Content-ID (an image in the body or a signature). */
  readonly related: boolean;
  readonly contentId: string | null;
  readonly bytes: Uint8Array;
}

/** A raw RFC 5322 message, read. Everything in it was written by the sender: data only. */
export interface ParsedEmail {
  /** `<id>`, or null when the message has none. */
  readonly messageId: string | null;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  readonly subject: string;
  readonly from: ParsedAddress | null;
  readonly replyTo: readonly ParsedAddress[];
  readonly to: readonly ParsedAddress[];
  readonly cc: readonly ParsedAddress[];
  /** The Date header as an ISO time, or null when missing or unreadable. */
  readonly date: string | null;
  readonly text: string | null;
  readonly html: string | null;
  readonly attachments: readonly ParsedAttachment[];
  /** Every header, lower-case name → values in order (a name can repeat). */
  readonly headers: ReadonlyMap<string, readonly string[]>;
  /** The top-level content type without parameters, lower case. */
  readonly contentType: string;
  /** The `report-type` parameter of a `multipart/report`, lower case. */
  readonly reportType: string | null;
  readonly sizeBytes: number;
}

/** Messages bigger than this are not read (25 MB is the usual limit of mail services). */
export const MAX_RAW_MESSAGE_BYTES = 40 * 1024 * 1024;

type PostalAddress = Address;

function flatten(addresses: readonly PostalAddress[] | PostalAddress | undefined): ParsedAddress[] {
  if (addresses === undefined) return [];
  const list: readonly PostalAddress[] = Array.isArray(addresses)
    ? (addresses as readonly PostalAddress[])
    : [addresses as PostalAddress];
  const out: ParsedAddress[] = [];
  for (const item of list) {
    const members: readonly { address: string; name: string }[] =
      item.group ??
      (item.address === undefined ? [] : [{ address: item.address, name: item.name }]);
    for (const member of members) {
      const address = normalizeAddress(member.address);
      if (address === null) continue;
      if (out.some((existing) => existing.address === address)) continue;
      const name = member.name.trim();
      out.push({ address, name: name.length === 0 ? null : name });
    }
  }
  return out;
}

function toBytes(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

function headerParameter(value: string, name: string): string | null {
  const match = new RegExp(`;\\s*${name}\\s*=\\s*"?([^";]+)"?`, "i").exec(value);
  return match?.[1]?.trim().toLowerCase() ?? null;
}

/**
 * Reads a raw message. `message/rfc822` parts stay attachments (a bounce carries the
 * original message that way, and a forwarded email is a file to the bot, not text).
 */
export async function parseEmail(raw: Uint8Array | string): Promise<ParsedEmail> {
  const sizeBytes = typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength;
  if (sizeBytes > MAX_RAW_MESSAGE_BYTES) {
    throw new ValidationError("The email is too large to read.", { details: { sizeBytes } });
  }
  let email: Email;
  try {
    email = await PostalMime.parse(raw, {
      forceRfc822Attachments: true,
      attachmentEncoding: "arraybuffer",
    });
  } catch (error) {
    throw new ValidationError("The email could not be read.", {
      details: { reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" },
    });
  }
  const headers = new Map<string, string[]>();
  for (const header of email.headers) {
    const list = headers.get(header.key) ?? [];
    list.push(header.value);
    headers.set(header.key, list);
  }
  const contentTypeHeader = headers.get("content-type")?.[0] ?? "text/plain";
  const contentType = (contentTypeHeader.split(";")[0] ?? "text/plain").trim().toLowerCase();
  const date = email.date === undefined ? null : new Date(email.date);
  const from = flatten(email.from)[0] ?? null;
  return {
    messageId: normalizeMessageId(email.messageId),
    inReplyTo: messageIdList(email.inReplyTo)[0] ?? null,
    references: messageIdList(email.references),
    subject: (email.subject ?? "").replace(/[\r\n]+/g, " ").trim(),
    from,
    replyTo: flatten(email.replyTo),
    to: flatten(email.to),
    cc: flatten(email.cc),
    date: date === null || Number.isNaN(date.getTime()) ? null : date.toISOString(),
    text: email.text ?? null,
    html: email.html ?? null,
    attachments: email.attachments.map((attachment) => ({
      fileName: attachment.filename,
      mimeType: attachment.mimeType.toLowerCase(),
      disposition:
        attachment.disposition === "attachment"
          ? "attachment"
          : attachment.disposition === "inline"
            ? "inline"
            : null,
      related: attachment.related === true,
      contentId: attachment.contentId ?? null,
      bytes: toBytes(attachment.content),
    })),
    headers,
    contentType,
    reportType:
      contentType === "multipart/report" ? headerParameter(contentTypeHeader, "report-type") : null,
    sizeBytes,
  };
}

/** The first value of a header, trimmed, or null. */
export function header(email: ParsedEmail, name: string): string | null {
  const value = email.headers.get(name.toLowerCase())?.[0];
  return value === undefined ? null : value.trim();
}
