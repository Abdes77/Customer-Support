/**
 * Live check of the message pipeline against a running app (`pnpm dev`, or a deployment)
 * and whatever job runner it uses: the Inngest dev server, Inngest Cloud, or the in-process
 * runner. It sends three quick customer messages through the test channel's webhook over
 * HTTP, delivers the first one again, and waits for the reply:
 *
 *   - the duplicate must be acknowledged as a duplicate (I2);
 *   - the three messages must get exactly one reply, from one turn that covers all three (I3);
 *   - the reply must be stored as sent, after the customer's messages (I4).
 *
 * Usage (variables from the shell or the root .env.local):
 *   DATABASE_URL=... APP_URL=http://localhost:3000 TEST_CHANNEL_SECRET=... \
 *     pnpm --filter @repo/pipeline live:roundtrip [--business <business id>]
 *
 * TEST_CHANNEL_SECRET must be the value the app runs with. The script writes a test
 * connection for the business if it has none, and leaves the conversation in the database.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";

import { signTestWebhook, testAccountIdFor, type TestWebhookBody } from "@repo/channel-test";
import { ensureTestConnection, loadTestChat } from "@repo/channel-test/server";
import { getEnv, requireEnv } from "@repo/core/env";
import { conversationTurns, createDatabase, eq } from "@repo/db";

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(path.resolve(import.meta.dirname, "../../..", file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const env = requireEnv(getEnv(), "DATABASE_URL", "APP_URL", "TEST_CHANNEL_SECRET");
  const db = createDatabase({ url: env.DATABASE_URL, max: 2 });
  try {
    const flag = process.argv.indexOf("--business");
    const wanted = flag === -1 ? undefined : process.argv[flag + 1];
    const businesses = await db.directory.listBusinesses({ statuses: ["active"] });
    const business = businesses.find((row) => wanted === undefined || row.businessId === wanted);
    if (business === undefined) throw new Error("No active business found (run pnpm db:seed).");
    await db.forBusiness(business.businessId).run((ctx) => ensureTestConnection(ctx));
    const accountId = testAccountIdFor(business.businessId);
    const visitorId = `live-${randomUUID()}`;
    const url = `${env.APP_URL.replace(/\/$/, "")}/api/webhooks/test`;

    const post = async (events: TestWebhookBody["events"]) => {
      const raw = JSON.stringify({ accountId, events } satisfies TestWebhookBody);
      const response = await fetch(url, {
        method: "POST",
        headers: signTestWebhook(env.TEST_CHANNEL_SECRET, raw),
        body: raw,
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const message = (id: string, text: string) => ({
      type: "message" as const,
      id,
      from: { id: visitorId, name: "Live check" },
      text,
      sentAt: new Date().toISOString(),
    });

    const started = Date.now();
    const texts = ["Hi there", "my furnace makes a banging noise", "when it starts up"];
    const ids = texts.map(() => `live-${randomUUID()}`);
    for (const [index, text] of texts.entries()) {
      const result = await post([message(ids[index]!, text)]);
      console.log(`POST message ${index + 1}: ${result.status} ${JSON.stringify(result.body)}`);
      if (result.status !== 200) throw new Error("The webhook did not answer 200.");
      await sleep(300);
    }
    const duplicate = await post([message(ids[0]!, texts[0]!)]);
    console.log(
      `POST duplicate of message 1: ${duplicate.status} ${JSON.stringify(duplicate.body)}`,
    );
    if (duplicate.body["duplicates"] !== 1 || duplicate.body["stored"] !== 0) {
      throw new Error("The duplicate delivery was not recognised as one.");
    }

    const businessId = business.businessId;
    let view = await db
      .forBusiness(businessId)
      .run((ctx) => loadTestChat(ctx, { businessId, visitorId }));
    for (let waited = 0; waited < 120_000; waited += 1000) {
      const done = view.messages.some(
        (row) => row.author === "bot" && row.status !== "queued" && row.status !== "sending",
      );
      if (done) break;
      await sleep(1000);
      view = await db
        .forBusiness(businessId)
        .run((ctx) => loadTestChat(ctx, { businessId, visitorId }));
    }
    // A moment more, so a second (wrong) reply would show up too.
    await sleep(3000);
    view = await db
      .forBusiness(businessId)
      .run((ctx) => loadTestChat(ctx, { businessId, visitorId }));
    const turns =
      view.conversationId === null
        ? []
        : await db.forBusiness(businessId).run(({ tx }) =>
            tx
              .select({
                ordinal: conversationTurns.ordinal,
                status: conversationTurns.status,
                pending: conversationTurns.pendingCount,
                runId: conversationTurns.runId,
              })
              .from(conversationTurns)
              .where(eq(conversationTurns.conversationId, view.conversationId!))
              .orderBy(conversationTurns.ordinal),
          );

    console.log(
      `\nConversation ${view.conversationId} after ${Math.round((Date.now() - started) / 1000)} s:`,
    );
    for (const row of view.messages) {
      console.log(
        `  #${row.sequence} ${row.author.padEnd(11)} ${row.status.padEnd(10)} ${row.text ?? ""}`,
      );
    }
    console.log(`Turns: ${JSON.stringify(turns)}`);

    const customer = view.messages.filter((row) => row.author === "customer");
    const replies = view.messages.filter((row) => row.author === "bot");
    const problems: string[] = [];
    if (customer.length !== 3)
      problems.push(`expected 3 customer messages, found ${customer.length}`);
    if (replies.length !== 1) problems.push(`expected 1 reply, found ${replies.length}`);
    if (replies[0]?.status !== "sent")
      problems.push(`the reply is ${replies[0]?.status ?? "missing"}, not sent`);
    // One turn answered all three messages. (The engine writes its own words, so the reply
    // is not compared with the customer's text.)
    const answering = turns.filter((turn) => turn.status === "replied");
    if (answering.length !== 1 || answering[0]?.pending !== 3)
      problems.push("the three messages were not answered by one turn");
    if ((replies[0]?.sequence ?? 0) < Math.max(...customer.map((row) => row.sequence)))
      problems.push("the reply is out of order");
    if (problems.length > 0) throw new Error(problems.join("; "));
    console.log(
      "\nLive round trip passed: one stored copy per message, one reply for three quick messages, sent in order.",
    );
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    `\nLive round trip FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
