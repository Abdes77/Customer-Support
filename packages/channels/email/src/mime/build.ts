import MailComposer from "nodemailer/lib/mail-composer";

import { LOOP_HEADER } from "../config";

export interface OutgoingAttachment {
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface OutgoingEmail {
  readonly from: { readonly address: string; readonly name: string | null };
  readonly to: readonly { readonly address: string; readonly name: string | null }[];
  readonly cc: readonly { readonly address: string; readonly name: string | null }[];
  readonly subject: string;
  readonly text: string;
  readonly html: string | null;
  /** `<id@domain>`. */
  readonly messageId: string;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  readonly date: Date;
  /** This connection's loop token, written into the marker header. */
  readonly loopToken: string;
  readonly attachments?: readonly OutgoingAttachment[];
}

function clean(value: string): string {
  // No header injection: a value never spans lines.
  return value.replace(/[\r\n]+/g, " ").trim();
}

function address(item: { readonly address: string; readonly name: string | null }) {
  const name = item.name === null ? "" : clean(item.name).replace(/["\\]/g, "");
  return name.length === 0 ? clean(item.address) : { name, address: clean(item.address) };
}

/**
 * The RFC 5322 message we send, with text and HTML alternatives, our Message-ID, the
 * threading headers of a reply, and two headers no reader sees: our loop marker, and
 * `X-Auto-Response-Suppress` (asks Exchange not to send out-of-office replies to it).
 * Nothing is read from disk or the network: contents are given as bytes only.
 */
export async function buildEmail(email: OutgoingEmail): Promise<Buffer> {
  const composer = new MailComposer({
    from: address(email.from),
    to: email.to.map(address),
    ...(email.cc.length > 0 ? { cc: email.cc.map(address) } : {}),
    subject: clean(email.subject),
    text: email.text,
    ...(email.html === null ? {} : { html: email.html }),
    messageId: email.messageId,
    ...(email.inReplyTo === null ? {} : { inReplyTo: email.inReplyTo }),
    ...(email.references.length === 0 ? {} : { references: [...email.references] }),
    date: email.date,
    headers: {
      [LOOP_HEADER]: clean(email.loopToken),
      "X-Auto-Response-Suppress": "OOF, AutoReply",
    },
    attachments: (email.attachments ?? []).map((item) => ({
      filename: clean(item.fileName),
      contentType: item.mimeType,
      content: Buffer.from(item.bytes),
    })),
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return composer.compile().build();
}
