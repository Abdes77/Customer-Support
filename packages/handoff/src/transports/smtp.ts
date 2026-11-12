import nodemailer from "nodemailer";

import { headerValue } from "../text";
import type { EmailTransport, TransportResult } from "./types";

/**
 * Alert email through the agency's SMTP server (`ALERT_SMTP_URL`, DECISIONS 19): plain text,
 * one recipient per message, the subject flattened to one line. nodemailer reads no files and
 * fetches no URLs here. A refusal is a failed result, never a throw.
 */
export function createSmtpAlertTransport(options: {
  /** smtp(s)://user:password@host:port */
  readonly url: string;
  readonly from: string;
  /** Tests inject nodemailer's stream or JSON transport here. */
  readonly transport?: Parameters<typeof nodemailer.createTransport>[0];
}): EmailTransport {
  const transporter = nodemailer.createTransport(
    options.transport ?? {
      url: options.url,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
      debug: false,
    },
  );
  return {
    async send({ to, subject, text }): Promise<TransportResult> {
      try {
        const info = (await transporter.sendMail({
          from: options.from,
          to,
          subject: headerValue(subject, 200),
          text,
          disableFileAccess: true,
          disableUrlAccess: true,
        })) as { messageId?: unknown };
        return {
          ok: true,
          providerId: typeof info.messageId === "string" ? info.messageId : null,
        };
      } catch (error) {
        const code =
          error !== null && typeof error === "object" && "responseCode" in error
            ? Number(error.responseCode)
            : null;
        return {
          ok: false,
          // 4xx SMTP replies are temporary; 5xx and connection setup errors are not retried.
          retryable: code === null || (code >= 400 && code < 500),
          code: code === null ? "smtp_error" : `smtp_${code}`,
          message: "The mail server did not accept the alert.",
        };
      }
    },
  };
}
