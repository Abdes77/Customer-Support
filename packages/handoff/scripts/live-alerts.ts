/**
 * Live check of the alert transports (HUMAN_TODO 33) with the app's own clients and the
 * credentials in the environment (`TWILIO_*`, `ALERT_SMTP_URL`, `ALERT_EMAIL_FROM`,
 * `ALERT_WHATSAPP_*`). Sends one test message per channel asked for; prints what each
 * provider answered, never a credential.
 *
 *   pnpm --filter @repo/handoff live:alerts --phone +15125550123 [--sms] [--call]
 *     [--whatsapp] [--email you@example.com]
 *
 * The call plays the escalation message and, when APP_URL is a public https address,
 * offers "press 1" with a gather URL that only a real escalation's secret would accept
 * (pressing 1 here answers "not acknowledged"). A trial Twilio account can only reach
 * verified numbers.
 */
import { parseArgs } from "node:util";

import { getEnv } from "@repo/core/env";

import { alertTransportsFromEnv, escalationTwiml, publicUrl } from "../src";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      phone: { type: "string" },
      email: { type: "string" },
      sms: { type: "boolean", default: false },
      call: { type: "boolean", default: false },
      whatsapp: { type: "boolean", default: false },
    },
  });
  const env = getEnv();
  const transports = alertTransportsFromEnv({ env });
  const text = "Test alert from the home-services reply bot: alerts reach you here.";
  const results: [string, unknown][] = [];
  if (values.sms) {
    if (values.phone === undefined || transports.sms === null) {
      results.push(["sms", "skipped: needs --phone and the TWILIO_* variables"]);
    } else {
      results.push([
        "sms",
        await transports.sms.send({ to: values.phone, body: text, statusCallbackUrl: null }),
      ]);
    }
  }
  if (values.call) {
    if (values.phone === undefined || transports.voice === null) {
      results.push(["call", "skipped: needs --phone and the TWILIO_* variables"]);
    } else {
      const appUrl = env.APP_URL ?? "";
      const gather = appUrl.startsWith("https://")
        ? publicUrl(
            appUrl,
            "/api/handoff/twilio/voice?alert=00000000-0000-4000-8000-000000000000&t=test",
          )
        : null;
      results.push([
        "call",
        await transports.voice.call({
          to: values.phone,
          twiml: escalationTwiml({
            businessName: "a test business",
            emergencyLabel: "a test emergency",
            gatherUrl: gather,
          }),
          statusCallbackUrl: null,
        }),
      ]);
    }
  }
  if (values.whatsapp) {
    if (values.phone === undefined || transports.whatsapp === null) {
      results.push(["whatsapp", "skipped: needs --phone and the ALERT_WHATSAPP_* variables"]);
    } else {
      results.push(["whatsapp", await transports.whatsapp.send({ to: values.phone, text })]);
    }
  }
  if (values.email !== undefined) {
    if (transports.email === null) {
      results.push(["email", "skipped: needs ALERT_SMTP_URL and ALERT_EMAIL_FROM"]);
    } else {
      results.push([
        "email",
        await transports.email.send({ to: values.email, subject: "Test alert", text }),
      ]);
    }
  }
  if (results.length === 0) {
    console.log("Nothing asked for: add --sms, --call, --whatsapp and/or --email <address>.");
  }
  for (const [channel, result] of results) console.log(channel, JSON.stringify(result));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
