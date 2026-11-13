import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import imapkit from "imapkit";

import type { MailServer } from "../config";
import { DEFAULT_MAIL_POLICY, type MailNetworkPolicy } from "../net/resolve";

/*
 * A real IMAP and SMTP server in the test process: ImapKit (an RFC-strict in-memory IMAP
 * server from the authors of imapflow) with its SMTP listener (smtp-server), which delivers
 * every message it accepts into the INBOX. IMAP is served with TLS from the start (like port
 * 993) and SMTP with STARTTLS (like port 587), both with ImapKit's test certificate for
 * 127.0.0.1, which the returned policy trusts. Used by the round-trip tests in `pnpm verify`
 * and by `pnpm --filter @repo/channel-email mail:server` for trying the app by hand.
 */

export interface LocalMailServer {
  readonly address: string;
  readonly password: string;
  readonly imap: MailServer;
  readonly smtp: MailServer;
  /** Trusts the local certificate and allows the loopback address and these ports. */
  readonly policy: MailNetworkPolicy;
  /** Puts a message in a folder, as a delivery would. */
  deliver(raw: string, folder?: string): { readonly uid: number };
  /** The messages of a folder, oldest first. */
  messages(folder?: string): { readonly uid: number; readonly raw: string }[];
  stop(): Promise<void>;
}

/** ImapKit's bundled test certificate (CN localhost, SAN 127.0.0.1 and ::1). */
export function localCertificate(): Buffer {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("imapkit");
  return readFileSync(path.resolve(path.dirname(entry), "../../cert/server.crt"));
}

interface ImapKitServer {
  start(port?: number, host?: string): Promise<number>;
  stop(): Promise<void>;
  readonly smtpServer: { readonly server: { address(): { port: number } } } | null;
  readonly tlsServer: { address(): { port: number } } | null;
  readonly control: {
    addMessage(path: string, message: { raw: string }): { uid: number };
    listMessages(path: string, options: { raw: boolean }): { uid: number; raw?: Buffer }[];
  };
}

export async function startLocalMailServer(
  options: { readonly address?: string; readonly password?: string } = {},
): Promise<LocalMailServer> {
  const address = options.address ?? "office@acme-roofing.com";
  const password = options.password ?? "local-test-password";
  const server = (imapkit as unknown as (options: unknown) => unknown)({
    plugins: [
      "ID",
      "ENABLE",
      "IDLE",
      "SPECIAL-USE",
      "UIDPLUS",
      "MOVE",
      "AUTH-PLAIN",
      "SASL-IR",
      "STARTTLS",
    ],
    users: { [address]: { password } },
    storage: {
      INBOX: {},
      "": {
        separator: "/",
        folders: { Sent: { "special-use": "\\Sent" }, Drafts: { "special-use": "\\Drafts" } },
      },
    },
    smtp: { port: 0, host: "127.0.0.1" },
    tls: { port: 0, host: "127.0.0.1" },
  }) as ImapKitServer;
  await server.start(0, "127.0.0.1");
  const imapsPort = server.tlsServer?.address().port;
  const smtpPort = server.smtpServer?.server.address().port;
  if (imapsPort === undefined || smtpPort === undefined)
    throw new Error("The local mail server did not start.");
  const ca = localCertificate();
  return {
    address,
    password,
    imap: { host: "127.0.0.1", port: imapsPort, security: "tls", username: address },
    smtp: { host: "127.0.0.1", port: smtpPort, security: "starttls", username: address },
    policy: {
      ...DEFAULT_MAIL_POLICY,
      isAllowedAddress: (candidate) => candidate === "127.0.0.1",
      imapPorts: [imapsPort],
      smtpPorts: [smtpPort],
      ca,
      timeoutMs: 10_000,
    },
    deliver(raw, folder = "INBOX") {
      return server.control.addMessage(folder, { raw });
    },
    messages(folder = "INBOX") {
      return server.control
        .listMessages(folder, { raw: true })
        .map((message) => ({ uid: message.uid, raw: message.raw?.toString("utf8") ?? "" }));
    },
    stop: () => server.stop(),
  };
}
