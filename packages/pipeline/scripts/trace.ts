/**
 * Prints the trace of one customer message (C17): the turn that answered it, its model calls
 * (tokens, cost, latency), its actions and the replies it sent with their delivery status.
 * Ids, statuses and numbers only, never message text. The business and message ids come from
 * the inbox URL, an alert, a log line or a Sentry event (tags `businessId`, `messageId`).
 *
 * Usage (DATABASE_URL from the shell or the root .env.local):
 *   pnpm --filter @repo/pipeline trace <business id> <message id>
 */
import path from "node:path";

import { BusinessId, MessageId } from "@repo/core";
import { getEnv, requireEnv } from "@repo/core/env";
import { createDatabase } from "@repo/db";

import { traceMessage } from "../src/trace";

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(path.resolve(import.meta.dirname, "../../..", file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function main(): Promise<void> {
  const [business, message] = process.argv.slice(2);
  const businessId = BusinessId.safeParse(business);
  const messageId = MessageId.safeParse(message);
  if (!businessId.success || !messageId.success) {
    console.error("Usage: pnpm --filter @repo/pipeline trace <business id> <message id>");
    process.exitCode = 2;
    return;
  }
  const env = requireEnv(getEnv(), "DATABASE_URL");
  const db = createDatabase({ url: env.DATABASE_URL, max: 1 });
  try {
    const ref = await db.directory.findBusiness(businessId.data);
    if (ref === null) {
      console.error("No such business.");
      process.exitCode = 1;
      return;
    }
    const trace = await db
      .forBusiness(ref.businessId, { agencyId: ref.agencyId })
      .run((ctx) => traceMessage(ctx, messageId.data));
    if (trace === null) {
      console.error("No customer message with that id in this business.");
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(trace, null, 2));
  } finally {
    await db.close();
  }
}

await main();
