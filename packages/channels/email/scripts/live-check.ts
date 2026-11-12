/**
 * Live check of an IMAP/SMTP inbox (HUMAN_TODO 14), with the same address rules, TLS checks
 * and MIME building as the app. The password is read from standard input, never from the
 * command line, and never printed.
 *
 *   pnpm --filter @repo/channel-email live:check --address office@yourdomain.com \
 *     --imap-host imap.yourdomain.com [--imap-port 993] [--imap-security tls|starttls] \
 *     --smtp-host smtp.yourdomain.com [--smtp-port 587] [--smtp-security starttls|tls] \
 *     [--user <login, default the address>] [--to you@example.com]
 *
 * Logs in to both servers (the connect check of the admin panel), lists the folders (the
 * Sent folder found by its special use), and with `--to` sends a test email that carries the
 * app's threading and loop headers, then shows the newest message of the INBOX. Reply to the
 * test email from `--to` and run the command again: the reply's In-Reply-To names the test
 * email's Message-ID, as the app's threading expects.
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import {
  buildEmail,
  checkSmtp,
  MailHostError,
  MailServerError,
  type MailServer,
  openImap,
  parseEmail,
  sendSmtp,
} from "../src";

async function readPassword(): Promise<string> {
  const lines = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await lines.question("Mailbox password (or app password), then Enter: ");
  lines.close();
  return answer.trim();
}

function server(host: string, port: string, security: string, username: string): MailServer {
  if (security !== "tls" && security !== "starttls")
    throw new Error(`Unknown security "${security}".`);
  return { host, port: Number(port), security, username };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      address: { type: "string" },
      user: { type: "string" },
      "imap-host": { type: "string" },
      "imap-port": { type: "string", default: "993" },
      "imap-security": { type: "string", default: "tls" },
      "smtp-host": { type: "string" },
      "smtp-port": { type: "string", default: "587" },
      "smtp-security": { type: "string", default: "starttls" },
      to: { type: "string" },
    },
  });
  if (
    values.address === undefined ||
    values["imap-host"] === undefined ||
    values["smtp-host"] === undefined
  ) {
    throw new Error(
      "Pass --address, --imap-host and --smtp-host (see the comment at the top of this file).",
    );
  }
  const user = values.user ?? values.address;
  const imap = server(values["imap-host"], values["imap-port"], values["imap-security"], user);
  const smtp = server(values["smtp-host"], values["smtp-port"], values["smtp-security"], user);
  const password = await readPassword();

  const session = await openImap(imap, password);
  try {
    const folders = await session.folders();
    console.log(
      `IMAP: logged in; ${folders.length} folders; Sent folder: ${folders.find((folder) => folder.specialUse === "\\Sent")?.path ?? "(none found)"}`,
    );
    const inbox = await session.open("INBOX");
    console.log(`IMAP: INBOX UIDVALIDITY ${inbox.uidValidity}, next UID ${inbox.uidNext}`);
    const newest = await session.fetchAfter(Math.max(0, inbox.uidNext - 2), 1);
    const last = newest.at(-1);
    if (last?.source != null) {
      const parsed = await parseEmail(last.source);
      console.log(
        `IMAP: newest message ${parsed.messageId ?? "(no id)"}, In-Reply-To ${parsed.inReplyTo ?? "(none)"}, References ${parsed.references.join(" ") || "(none)"}`,
      );
    }
  } finally {
    await session.close();
  }
  await checkSmtp(smtp, password);
  console.log("SMTP: logged in.");

  if (values.to !== undefined) {
    const messageId = `<${randomUUID()}@${values.address.split("@")[1]}>`;
    const raw = await buildEmail({
      from: { address: values.address, name: "Live check" },
      to: [{ address: values.to, name: null }],
      cc: [],
      subject: "Home-services reply bot: live check",
      text: "This is a test email from the live check. Reply to it, then run the check again.\n",
      html: "<div>This is a test email from the live check. Reply to it, then run the check again.</div>",
      messageId,
      inReplyTo: null,
      references: [],
      date: new Date(),
      loopToken: `live-check-${randomUUID().slice(0, 8)}`,
    });
    await sendSmtp(smtp, password, { from: values.address, recipients: [values.to], raw });
    console.log(`SMTP: sent the test email ${messageId} to ${values.to}.`);
  }
}

main().catch((error: unknown) => {
  if (error instanceof MailHostError)
    console.error(`Refused mail server (${error.reason}): ${error.message}`);
  else if (error instanceof MailServerError)
    console.error(`${error.message}${error.authFailed ? " (user name or password refused)" : ""}`);
  else console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
