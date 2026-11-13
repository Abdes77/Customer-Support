import { lookup } from "node:dns/promises";

import { AppError } from "@repo/core";

import { isIpLiteral, isPublicAddress } from "./address";

/*
 * An IMAP or SMTP server typed in by a user is a server-side request forgery surface: the
 * address must never make this server talk to something on its own network (the database,
 * a cloud metadata service). The rules mirror the website fetcher's (ARCHITECTURE §3):
 * private-network host names are refused before any lookup, the name is resolved once, every
 * address it has must be public, and the connection goes to exactly the address that was
 * checked (the TLS certificate is still verified against the host name). Only the standard
 * mail ports are allowed.
 */

export type MailHostRefusal = "host" | "dns" | "address" | "port";

/** The mail server was refused. `reason` and the message are safe to show. */
export class MailHostError extends AppError {
  readonly reason: MailHostRefusal;
  constructor(reason: MailHostRefusal, message: string, retryable = false) {
    super("validation_failed", message, { retryable, details: { reason } });
    this.reason = reason;
  }
}

export interface ResolvedMailHost {
  /** The checked address the socket connects to. */
  readonly address: string;
  /** The host name the TLS certificate must match (SNI), or undefined for an IP literal. */
  readonly servername: string | undefined;
}

export interface MailNetworkPolicy {
  /** DNS. Default: the system resolver, every address of the name. */
  readonly resolve: (host: string) => Promise<readonly string[]>;
  /** Default `isPublicAddress`. Only tests widen it, to reach a server on loopback. */
  readonly isAllowedAddress: (address: string) => boolean;
  readonly imapPorts: readonly number[];
  readonly smtpPorts: readonly number[];
  /** Extra trusted certificate authorities (tests: the local mail server's certificate). */
  readonly ca?: string | Buffer;
  /** Time for connecting and each command, ms. */
  readonly timeoutMs: number;
}

const PRIVATE_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".lan",
  ".corp",
  ".home",
  ".home.arpa",
  ".localdomain",
];

async function systemResolve(host: string): Promise<readonly string[]> {
  const answers = await lookup(host, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
}

export const DEFAULT_MAIL_POLICY: MailNetworkPolicy = {
  resolve: systemResolve,
  isAllowedAddress: isPublicAddress,
  // IMAPS and IMAP with STARTTLS; SMTPS, submission, SMTP and the common alternative port.
  imapPorts: [993, 143],
  smtpPorts: [465, 587, 25, 2525],
  timeoutMs: 20_000,
};

/** Checks a user-supplied mail server and returns the address to connect to. */
export async function resolveMailHost(
  host: string,
  port: number,
  kind: "imap" | "smtp",
  policy: MailNetworkPolicy = DEFAULT_MAIL_POLICY,
): Promise<ResolvedMailHost> {
  const ports = kind === "imap" ? policy.imapPorts : policy.smtpPorts;
  if (!ports.includes(port)) {
    throw new MailHostError(
      "port",
      `Use a standard ${kind.toUpperCase()} port (${ports.join(", ")}).`,
    );
  }
  const name = host.trim().toLowerCase().replace(/\.$/, "");
  if (isIpLiteral(name)) {
    const literal = name.replace(/^\[(.*)\]$/, "$1");
    if (!policy.isAllowedAddress(literal)) {
      throw new MailHostError("address", "The mail server must be on the public internet.");
    }
    return { address: literal, servername: undefined };
  }
  if (
    name.length === 0 ||
    name === "localhost" ||
    !name.includes(".") ||
    PRIVATE_SUFFIXES.some((suffix) => name.endsWith(suffix)) ||
    !/^[a-z0-9.-]+$/.test(name)
  ) {
    throw new MailHostError("host", "The mail server's name is not a public host name.");
  }
  let addresses: readonly string[];
  try {
    addresses = await policy.resolve(name);
  } catch {
    throw new MailHostError("dns", "The mail server's name could not be found.", true);
  }
  if (addresses.length === 0) {
    throw new MailHostError("dns", "The mail server's name could not be found.", true);
  }
  if (!addresses.every((address) => policy.isAllowedAddress(address))) {
    throw new MailHostError("address", "The mail server must be on the public internet.");
  }
  return { address: addresses[0]!, servername: name };
}
