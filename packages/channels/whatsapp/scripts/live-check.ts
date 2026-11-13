/**
 * Live checks of the WhatsApp channel against Meta's real Cloud API (HUMAN_TODO 29). Needs a
 * Meta app with the WhatsApp product and its test number.
 *
 *   pnpm --filter @repo/channel-whatsapp live:check
 *     Reads the test number, sends the `hello_world` template to your own phone (works at any
 *     time), then a free-form text and reply buttons (work only within 24 hours of your last
 *     message to the test number: write to it first), and lists the account's templates.
 *     Variables: META_TEST_WHATSAPP_PHONE_NUMBER_ID, META_TEST_WHATSAPP_ACCESS_TOKEN,
 *     META_TEST_WHATSAPP_RECIPIENT, META_TEST_WHATSAPP_BUSINESS_ACCOUNT_ID (for templates),
 *     META_GRAPH_API_VERSION (optional).
 *
 *   pnpm --filter @repo/channel-whatsapp live:check connect --business <business id>
 *     Stores the test number as that business's WhatsApp connection (token encrypted), the
 *     way Embedded Signup would, so a real conversation can round-trip through a running app
 *     whose webhook Meta calls. Also needs DATABASE_URL and CREDENTIALS_ENCRYPTION_KEY.
 *
 * Tokens are never printed.
 */
import path from "node:path";
import { parseArgs } from "node:util";

import { createGraphClient, GraphApiError } from "@repo/channel-meta";
import { createLogger } from "@repo/core";
import { getEnv, requireEnv } from "@repo/core/env";
import { channelConnections, createDatabase } from "@repo/db";

import { createWhatsAppAdapter, recipientOf } from "../src";
import { createTemplateService } from "../src/server/templates";

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(path.resolve(import.meta.dirname, "../../../..", file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function describe(error: unknown): string {
  if (error instanceof GraphApiError) {
    return `Graph error ${error.graphCode ?? "(no answer)"}: ${error.message}${
      error.classification.windowClosed
        ? " (the 24-hour window is closed: send a message to the test number, then run again)"
        : ""
    }`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function check(): Promise<void> {
  const all = getEnv();
  const env = requireEnv(
    all,
    "META_TEST_WHATSAPP_PHONE_NUMBER_ID",
    "META_TEST_WHATSAPP_ACCESS_TOKEN",
    "META_TEST_WHATSAPP_RECIPIENT",
  );
  const graph = createGraphClient({ version: all.META_GRAPH_API_VERSION });
  const token = env.META_TEST_WHATSAPP_ACCESS_TOKEN;
  const phone = env.META_TEST_WHATSAPP_PHONE_NUMBER_ID;
  let failures = 0;
  const step = async (name: string, run: () => Promise<string>) => {
    try {
      console.log(`ok   ${name}: ${await run()}`);
    } catch (error) {
      failures += 1;
      console.log(`FAIL ${name}: ${describe(error)}`);
    }
  };

  await step("read the number", async () => {
    const info = await graph.request<Record<string, unknown>>({
      method: "GET",
      path: `/${phone}`,
      token,
      query: { fields: "display_phone_number,verified_name,quality_rating" },
    });
    return `${String(info["display_phone_number"])} (${String(info["verified_name"])}, quality ${String(info["quality_rating"])})`;
  });

  const adapter = createWhatsAppAdapter({ appSecret: "unused", verifyToken: "unused", graph });
  const target = {
    connection: {
      connectionId: "00000000-0000-4000-8000-000000000000",
      businessId: "00000000-0000-4000-8000-000000000000",
      externalAccountId: phone,
      credentials: { accessToken: token },
      config: {},
    },
    conversationId: "00000000-0000-4000-8000-000000000000",
    recipientExternalId: env.META_TEST_WHATSAPP_RECIPIENT,
    externalThreadId: null,
    replyToExternalMessageId: null,
    window: { open: true, closesAt: null },
    email: null,
    idempotencyKey: "live-check",
    sentByHuman: false,
  } as unknown as Parameters<typeof adapter.send>[1];
  console.log(`     recipient field: ${Object.keys(recipientOf(target.recipientExternalId))[0]}`);

  const send = async (message: Parameters<typeof adapter.send>[0]) => {
    const result = await adapter.send(message, target);
    if (!result.ok) {
      throw new Error(
        `${result.error.code}: ${result.error.message}${result.error.windowClosed ? " (24-hour window closed: write to the test number first)" : ""}`,
      );
    }
    return result.externalMessageId;
  };
  await step("send the hello_world template", () =>
    send({ kind: "template", templateName: "hello_world", languageCode: "en_US", variables: [] }),
  );
  await step("send free-form text", () =>
    send({ kind: "text", text: "Live check from the home-services reply bot: free-form text." }),
  );
  await step("send reply buttons", () =>
    send({
      kind: "text",
      text: "Live check: which works better?",
      quickReplies: ["This week", "Next week", "Not sure"],
    }),
  );
  const waba = all.META_TEST_WHATSAPP_BUSINESS_ACCOUNT_ID;
  if (waba !== undefined) {
    await step("list templates", async () => {
      const list = await graph.request<{ data: { name: string; status: string }[] }>({
        method: "GET",
        path: `/${waba}/message_templates`,
        token,
        query: { fields: "name,status,language", limit: 50 },
      });
      return list.data.map((item) => `${item.name} (${item.status})`).join(", ") || "none";
    });
  }
  if (failures > 0) process.exitCode = 1;
}

async function connect(businessId: string): Promise<void> {
  const all = getEnv();
  const env = requireEnv(
    all,
    "DATABASE_URL",
    "META_TEST_WHATSAPP_PHONE_NUMBER_ID",
    "META_TEST_WHATSAPP_ACCESS_TOKEN",
    "META_TEST_WHATSAPP_BUSINESS_ACCOUNT_ID",
  );
  const db = createDatabase({ url: env.DATABASE_URL, max: 2 });
  try {
    const business = await db.directory.findBusiness(businessId as never);
    if (business === null) throw new Error(`There is no business ${businessId}.`);
    const id = await db.forBusiness(business.businessId).run(async (ctx) => {
      const values = {
        status: "active" as const,
        displayName: "Meta test number",
        config: {
          businessAccountId: env.META_TEST_WHATSAPP_BUSINESS_ACCOUNT_ID,
          phoneNumberId: env.META_TEST_WHATSAPP_PHONE_NUMBER_ID,
        },
        connectedAt: new Date(),
      };
      const [row] = await ctx.tx
        .insert(channelConnections)
        .values({
          ...ctx.tenant,
          channel: "whatsapp",
          externalAccountId: env.META_TEST_WHATSAPP_PHONE_NUMBER_ID,
          ...values,
        })
        .onConflictDoUpdate({
          target: [channelConnections.channel, channelConnections.externalAccountId],
          set: values,
        })
        .returning({ id: channelConnections.id });
      await db.secrets.channel.write(ctx, row!.id, {
        accessToken: env.META_TEST_WHATSAPP_ACCESS_TOKEN,
      });
      return row!.id;
    });
    console.log(`Connected the test number to business ${business.businessId} (connection ${id}).`);
    const templates = createTemplateService({
      db,
      graph: createGraphClient({ version: all.META_GRAPH_API_VERSION }),
      logger: createLogger({ level: "warn" }),
    });
    const { synced } = await templates.sync(business, id);
    console.log(`Synced ${synced} templates.`);
  } finally {
    await db.close();
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { business: { type: "string" } },
  });
  if (positionals[0] === "connect") {
    if (values.business === undefined) {
      throw new Error(
        "Usage: pnpm --filter @repo/channel-whatsapp live:check connect --business <id>",
      );
    }
    await connect(values.business);
    return;
  }
  await check();
}

main().catch((error: unknown) => {
  console.error(describe(error));
  process.exitCode = 1;
});
