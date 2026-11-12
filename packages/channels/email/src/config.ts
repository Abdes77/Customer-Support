import { z } from "zod";

/*
 * What an email connection stores. `config` (non-secret, chosen at connect time) and `state`
 * (non-secret, kept by the system: sync cursors, watch and subscription expiry) live on the
 * `channel_connections` row; the credentials are one encrypted document in
 * `channel_connection_secrets`. The connection's `external_account_id` is the inbox address
 * in lower case: a mailbox belongs to one business.
 */

export const EMAIL_PROVIDERS = ["gmail", "microsoft", "imap"] as const;
export const EmailProvider = z.enum(EMAIL_PROVIDERS);
export type EmailProvider = z.infer<typeof EmailProvider>;

/** Implicit TLS (IMAPS 993, SMTPS 465) or STARTTLS (IMAP 143, submission 587). */
export const MailSecurity = z.enum(["tls", "starttls"]);
export type MailSecurity = z.infer<typeof MailSecurity>;

export const HostName = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9.-]+$|^\[?[0-9a-f:.]+\]?$/, "a host name or address");

export const MailServer = z.object({
  host: HostName,
  port: z.number().int().min(1).max(65_535),
  security: MailSecurity,
  username: z.string().min(1).max(320),
});
export type MailServer = z.infer<typeof MailServer>;

const Base = z.object({
  /** The inbox address, lower case (also the connection's external account id). */
  address: z.email(),
  displayName: z.string().max(200).nullable().default(null),
  /**
   * Marks every email we send from this connection (header `X-HSRB-Loop`), so our own mail
   * coming back is recognized and another instance of this system is never answered.
   * Not a secret.
   */
  loopToken: z.string().min(16).max(64),
});

export const GmailConfig = Base.extend({ provider: z.literal("gmail") });
export const MicrosoftConfig = Base.extend({
  provider: z.literal("microsoft"),
  /** The mailbox owner's Graph user id. */
  userId: z.string().min(1).max(200).nullable().default(null),
});
export const ImapConfig = Base.extend({
  provider: z.literal("imap"),
  imap: MailServer,
  smtp: MailServer,
  /** Path of the folder with the `\Sent` special use, when the server has one. */
  sentFolder: z.string().min(1).max(500).nullable().default(null),
  /** Copy what the bot sends into the Sent folder, as a mail program does. */
  appendSent: z.boolean().default(true),
});

export const EmailConnectionConfig = z.discriminatedUnion("provider", [
  GmailConfig,
  MicrosoftConfig,
  ImapConfig,
]);
export type EmailConnectionConfig = z.infer<typeof EmailConnectionConfig>;
export type GmailConfig = z.infer<typeof GmailConfig>;
export type MicrosoftConfig = z.infer<typeof MicrosoftConfig>;
export type ImapConfig = z.infer<typeof ImapConfig>;

/** OAuth tokens of a Gmail or Microsoft connection. */
export const OAuthCredentials = z.object({
  kind: z.literal("oauth"),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).nullable(),
  /** When the access token expires (ISO time). */
  expiresAt: z.string(),
  scope: z.string().default(""),
});
export type OAuthCredentials = z.infer<typeof OAuthCredentials>;

/** Passwords (or app passwords) of an IMAP/SMTP connection. */
export const PasswordCredentials = z.object({
  kind: z.literal("password"),
  imapPassword: z.string().min(1).max(1000),
  smtpPassword: z.string().min(1).max(1000),
});
export type PasswordCredentials = z.infer<typeof PasswordCredentials>;

export const EmailCredentials = z.discriminatedUnion("kind", [
  OAuthCredentials,
  PasswordCredentials,
]);
export type EmailCredentials = z.infer<typeof EmailCredentials>;

export const ImapFolderCursor = z.object({
  uidValidity: z.string(),
  lastUid: z.number().int().nonnegative(),
});
export type ImapFolderCursor = z.infer<typeof ImapFolderCursor>;

/** The system's own bookkeeping on the connection row. */
export const EmailConnectionState = z
  .object({
    /** Graph subscription id: the key a change notification is matched by (unique index). */
    subscriptionId: z.string().min(1).nullable().optional(),
    gmail: z
      .object({
        historyId: z.string().min(1),
        watchExpiresAt: z.string().nullable().default(null),
      })
      .optional(),
    microsoft: z
      .object({
        subscriptionExpiresAt: z.string().nullable().default(null),
        deltaLinks: z.record(z.string(), z.string()).default({}),
      })
      .optional(),
    imap: z
      .object({
        folders: z.record(z.string(), ImapFolderCursor).default({}),
      })
      .optional(),
    lastSyncAt: z.string().nullable().optional(),
    lastSyncError: z.string().nullable().optional(),
  })
  .passthrough();
export type EmailConnectionState = z.infer<typeof EmailConnectionState>;

/** The state of a row, or an empty state when it does not parse (it is rebuilt by a sync). */
export function readState(value: unknown): EmailConnectionState {
  const parsed = EmailConnectionState.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
}

/** The header that marks our own sends. */
export const LOOP_HEADER = "x-hsrb-loop";
