import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";

import { ExternalServiceError } from "@repo/core";

import type { MailServer } from "../config";
import { MAX_RAW_MESSAGE_BYTES } from "../mime/parse";
import { DEFAULT_MAIL_POLICY, type MailNetworkPolicy, resolveMailHost } from "../net/resolve";

/*
 * IMAP (RFC 9051 / 3501, through `imapflow`) and SMTP (RFC 5321, through `nodemailer`) for an
 * inbox on the business's own domain. Both connect to the address `resolveMailHost` checked,
 * verify the TLS certificate against the host name, and never send a password in clear: port
 * 993/465 use TLS from the start, 143/587/25 must upgrade with STARTTLS or fail.
 */

export interface ImapFolderInfo {
  readonly path: string;
  readonly specialUse: string | null;
}

export interface ImapMessage {
  readonly uid: number;
  readonly size: number;
  /** Null when the message is bigger than the limit and was not downloaded. */
  readonly source: Uint8Array | null;
}

export interface ImapSession {
  folders(): Promise<ImapFolderInfo[]>;
  /** Opens a folder read-only (nothing is marked as read). */
  open(path: string): Promise<{ readonly uidValidity: string; readonly uidNext: number }>;
  /** Messages of the open folder with a UID above `afterUid`, oldest first, at most `limit`. */
  fetchAfter(afterUid: number, limit: number): Promise<ImapMessage[]>;
  append(path: string, raw: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export class MailServerError extends ExternalServiceError {
  /** The server refused the user name or password. */
  readonly authFailed: boolean;
  constructor(
    protocol: "imap" | "smtp",
    message: string,
    options: { authFailed: boolean; retryable: boolean },
  ) {
    super(message, {
      provider: protocol,
      retryable: options.retryable,
      details: { authFailed: options.authFailed },
    });
    this.authFailed = options.authFailed;
  }
}

function describe(error: unknown): { message: string; authFailed: boolean; retryable: boolean } {
  const record = (error ?? {}) as Record<string, unknown>;
  const code = typeof record["code"] === "string" ? record["code"] : "";
  const responseCode = typeof record["responseCode"] === "number" ? record["responseCode"] : null;
  const authFailed =
    record["authenticationFailed"] === true ||
    code === "EAUTH" ||
    code === "AUTHENTICATIONFAILED" ||
    (typeof record["serverResponseCode"] === "string" &&
      record["serverResponseCode"] === "AUTHENTICATIONFAILED") ||
    responseCode === 535;
  const permanent = record["permanent"] === true || (responseCode !== null && responseCode >= 500);
  const text = error instanceof Error ? error.message : "unknown error";
  // Server answers can quote what was sent: keep only the start, never the credentials.
  return {
    message: text.replace(/\s+/g, " ").slice(0, 200),
    authFailed,
    retryable: !authFailed && !permanent,
  };
}

/** Opens an IMAP session. The caller must `close()` it. */
export async function openImap(
  server: MailServer,
  password: string,
  policy: MailNetworkPolicy = DEFAULT_MAIL_POLICY,
): Promise<ImapSession> {
  const target = await resolveMailHost(server.host, server.port, "imap", policy);
  const client = new ImapFlow({
    host: target.address,
    port: server.port,
    secure: server.security === "tls",
    doSTARTTLS: server.security === "starttls",
    ...(target.servername === undefined ? {} : { servername: target.servername }),
    auth: { user: server.username, pass: password },
    tls: {
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      ...(target.servername === undefined ? {} : { servername: target.servername }),
      ...(policy.ca === undefined ? {} : { ca: policy.ca }),
    },
    logger: false,
    emitLogs: false,
    disableAutoIdle: true,
    connectionTimeout: policy.timeoutMs,
    greetingTimeout: policy.timeoutMs,
    socketTimeout: policy.timeoutMs * 3,
    maxLiteralSize: MAX_RAW_MESSAGE_BYTES,
  });
  // A dropped connection must not crash the process.
  client.on("error", () => undefined);
  try {
    await client.connect();
  } catch (error) {
    const info = describe(error);
    client.close();
    throw new MailServerError("imap", `IMAP: ${info.message}`, info);
  }
  let opened = false;
  return {
    async folders() {
      const list = await client.list();
      return list.map((item) => ({ path: item.path, specialUse: item.specialUse ?? null }));
    },
    async open(path) {
      const box = await client.mailboxOpen(path, { readOnly: true });
      opened = true;
      return { uidValidity: box.uidValidity.toString(), uidNext: box.uidNext };
    },
    async fetchAfter(afterUid, limit) {
      if (!opened) throw new Error("No folder is open.");
      // "n:*" also returns the newest message when its UID is below n, so filter again.
      const sizes: { uid: number; size: number }[] = [];
      for await (const message of client.fetch(
        `${afterUid + 1}:*`,
        { uid: true, size: true },
        { uid: true },
      )) {
        if (message.uid > afterUid) sizes.push({ uid: message.uid, size: message.size ?? 0 });
      }
      sizes.sort((a, b) => a.uid - b.uid);
      const wanted = sizes.slice(0, limit);
      const out: ImapMessage[] = [];
      for (const item of wanted) {
        if (item.size > MAX_RAW_MESSAGE_BYTES) {
          out.push({ uid: item.uid, size: item.size, source: null });
          continue;
        }
        const message = await client.fetchOne(
          String(item.uid),
          { uid: true, source: true },
          { uid: true },
        );
        const source = message === false ? undefined : message.source;
        out.push({
          uid: item.uid,
          size: item.size,
          source: source === undefined ? null : new Uint8Array(source),
        });
      }
      return out;
    },
    async append(path, raw) {
      await client.append(path, Buffer.from(raw), ["\\Seen"]);
    },
    async close() {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    },
  };
}

/** Logs in over IMAP and lists the folders: the connect check. */
export async function checkImap(
  server: MailServer,
  password: string,
  policy: MailNetworkPolicy = DEFAULT_MAIL_POLICY,
): Promise<{
  readonly sentFolder: string | null;
  readonly inbox: { readonly uidValidity: string; readonly uidNext: number };
}> {
  const session = await openImap(server, password, policy);
  try {
    const folders = await session.folders();
    const sent = folders.find((folder) => folder.specialUse === "\\Sent")?.path ?? null;
    const inbox = await session.open("INBOX");
    return { sentFolder: sent, inbox };
  } finally {
    await session.close();
  }
}

export interface SmtpSendInput {
  readonly from: string;
  readonly recipients: readonly string[];
  readonly raw: Uint8Array;
}

function smtpTransport(
  server: MailServer,
  password: string,
  target: { address: string; servername: string | undefined },
  policy: MailNetworkPolicy,
) {
  return nodemailer.createTransport({
    host: target.address,
    port: server.port,
    secure: server.security === "tls",
    requireTLS: server.security === "starttls",
    ignoreTLS: false,
    auth: { user: server.username, pass: password },
    tls: {
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      ...(target.servername === undefined ? {} : { servername: target.servername }),
      ...(policy.ca === undefined ? {} : { ca: policy.ca }),
    },
    connectionTimeout: policy.timeoutMs,
    greetingTimeout: policy.timeoutMs,
    socketTimeout: policy.timeoutMs * 3,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  });
}

/** Sends one prepared message by SMTP. */
export async function sendSmtp(
  server: MailServer,
  password: string,
  input: SmtpSendInput,
  policy: MailNetworkPolicy = DEFAULT_MAIL_POLICY,
): Promise<void> {
  const target = await resolveMailHost(server.host, server.port, "smtp", policy);
  const transport = smtpTransport(server, password, target, policy);
  try {
    await transport.sendMail({
      envelope: { from: input.from, to: [...input.recipients] },
      raw: Buffer.from(input.raw),
    });
  } catch (error) {
    const info = describe(error);
    throw new MailServerError("smtp", `SMTP: ${info.message}`, info);
  } finally {
    transport.close();
  }
}

/** Logs in over SMTP without sending: the connect check. */
export async function checkSmtp(
  server: MailServer,
  password: string,
  policy: MailNetworkPolicy = DEFAULT_MAIL_POLICY,
): Promise<void> {
  const target = await resolveMailHost(server.host, server.port, "smtp", policy);
  const transport = smtpTransport(server, password, target, policy);
  try {
    await transport.verify();
  } catch (error) {
    const info = describe(error);
    throw new MailServerError("smtp", `SMTP: ${info.message}`, info);
  } finally {
    transport.close();
  }
}
