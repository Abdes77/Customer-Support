/**
 * Live checks of Messenger and Instagram against Meta's real Graph API (HUMAN_TODO 30). Needs a
 * Meta app with Messenger and Instagram, a test Page you administer and, for Instagram, the
 * professional account linked to it.
 *
 *   pnpm --filter @repo/channel-messenger-instagram live:check
 *     Reads the Page and its linked Instagram account, subscribes the app to the Page's
 *     messaging webhook fields and lists them. Variables: META_TEST_PAGE_ID,
 *     META_TEST_PAGE_ACCESS_TOKEN, META_TEST_INSTAGRAM_ACCOUNT_ID (optional),
 *     META_GRAPH_API_VERSION (optional).
 *
 *   pnpm --filter @repo/channel-messenger-instagram live:check send --to <PSID> [--instagram]
 *     Sends a text with quick replies, typing and seen indicators to that person (write to the
 *     Page, or the Instagram account, first: the standard window must be open). The PSID or
 *     IGSID is the `sender.id` of their message in the webhook (Meta's App Dashboard shows
 *     test deliveries) or the conversation's contact in the inbox.
 *
 *   pnpm --filter @repo/channel-messenger-instagram live:check connect --business <business id>
 *     Stores the test Page (and the Instagram account, when set) as that business's
 *     connections (token encrypted), the way Facebook Login would, so a real conversation can
 *     round-trip through a running app whose webhooks Meta calls. Also needs DATABASE_URL and
 *     CREDENTIALS_ENCRYPTION_KEY.
 *
 * Tokens are never printed.
 */
import path from "node:path";
import { parseArgs } from "node:util";

import { createGraphClient, GraphApiError } from "@repo/channel-meta";
import { getEnv, requireEnv } from "@repo/core/env";
import { channelConnections, createDatabase, eq } from "@repo/db";

import { createMetaMessagingAdapter } from "../src";
import { PAGE_SUBSCRIBED_FIELDS } from "../src/server/connections";

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(path.resolve(import.meta.dirname, "../../../..", file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function describe(error: unknown): string {
  if (error instanceof GraphApiError) {
    return `Graph error ${error.graphCode ?? "(no answer)"}${error.subcode === null ? "" : `/${error.subcode}`}: ${error.message}${
      error.classification.windowClosed
        ? " (the standard window is closed: write to the Page first, then run again)"
        : ""
    }`;
  }
  return error instanceof Error ? error.message : String(error);
}

function testPage() {
  const all = getEnv();
  const env = requireEnv(all, "META_TEST_PAGE_ID", "META_TEST_PAGE_ACCESS_TOKEN");
  return {
    all,
    pageId: env.META_TEST_PAGE_ID,
    token: env.META_TEST_PAGE_ACCESS_TOKEN,
    instagramId: all.META_TEST_INSTAGRAM_ACCOUNT_ID ?? null,
    graph: createGraphClient({ version: all.META_GRAPH_API_VERSION }),
  };
}

async function check(): Promise<void> {
  const { pageId, token, instagramId, graph } = testPage();
  let failures = 0;
  const step = async (name: string, run: () => Promise<string>) => {
    try {
      console.log(`ok   ${name}: ${await run()}`);
    } catch (error) {
      failures += 1;
      console.log(`FAIL ${name}: ${describe(error)}`);
    }
  };
  await step("read the Page", async () => {
    const page = await graph.request<Record<string, unknown>>({
      method: "GET",
      path: `/${pageId}`,
      token,
      query: { fields: "id,name,instagram_business_account{id,username}" },
    });
    const instagram = page["instagram_business_account"] as
      { id?: string; username?: string } | undefined;
    if (instagramId !== null && instagram?.id !== instagramId) {
      throw new Error(
        `The Page is linked to Instagram ${instagram?.id ?? "nothing"}, not ${instagramId}.`,
      );
    }
    return `${String(page["name"])}${instagram === undefined ? "" : `, Instagram @${instagram.username ?? instagram.id}`}`;
  });
  await step("subscribe the app to the Page's messaging fields", async () => {
    await graph.request({
      method: "POST",
      path: `/${pageId}/subscribed_apps`,
      token,
      query: { subscribed_fields: PAGE_SUBSCRIBED_FIELDS.join(",") },
    });
    const apps = await graph.request<{ data: { name?: string; subscribed_fields?: string[] }[] }>({
      method: "GET",
      path: `/${pageId}/subscribed_apps`,
      token,
    });
    return apps.data
      .map((app) => `${app.name ?? "app"} [${(app.subscribed_fields ?? []).join(", ")}]`)
      .join("; ");
  });
  if (failures > 0) process.exitCode = 1;
}

async function send(to: string, instagram: boolean): Promise<void> {
  const { pageId, token, instagramId, graph } = testPage();
  const channel = instagram ? "instagram" : "messenger";
  if (instagram && instagramId === null) throw new Error("Set META_TEST_INSTAGRAM_ACCOUNT_ID.");
  const adapter = createMetaMessagingAdapter(channel, {
    appSecret: "unused",
    verifyToken: "unused",
    graph,
  });
  const target = {
    connection: {
      connectionId: "00000000-0000-4000-8000-000000000000",
      businessId: "00000000-0000-4000-8000-000000000000",
      externalAccountId: instagram ? instagramId : pageId,
      credentials: { pageAccessToken: token },
      config: { pageId, pageName: null, instagramAccountId: instagramId, instagramUsername: null },
    },
    conversationId: "00000000-0000-4000-8000-000000000000",
    recipientExternalId: to,
    externalThreadId: null,
    replyToExternalMessageId: null,
    window: { open: true, closesAt: null },
    email: null,
    idempotencyKey: "live-check",
    sentByHuman: false,
    standardWindowOpen: true,
  } as unknown as Parameters<typeof adapter.send>[1];
  await adapter.markRead?.(target, "unused");
  await adapter.sendTyping?.(target, "on");
  const result = await adapter.send(
    {
      kind: "text",
      text: `Live check from the home-services reply bot on ${channel}: which works better?`,
      quickReplies: ["This week", "Next week"],
    },
    target,
  );
  if (!result.ok) {
    throw new Error(
      `${result.error.code}: ${result.error.message}${result.error.windowClosed ? " (write to the Page first)" : ""}`,
    );
  }
  console.log(`ok   sent ${result.externalMessageId}`);
}

async function connect(businessId: string): Promise<void> {
  const { all, pageId, token, instagramId } = testPage();
  const env = requireEnv(all, "DATABASE_URL");
  const db = createDatabase({ url: env.DATABASE_URL, max: 2 });
  try {
    const business = await db.directory.findBusiness(businessId as never);
    if (business === null) throw new Error(`There is no business ${businessId}.`);
    const accounts: ["messenger" | "instagram", string][] = [["messenger", pageId]];
    if (instagramId !== null) accounts.push(["instagram", instagramId]);
    await db.forBusiness(business.businessId).run(async (ctx) => {
      for (const [channel, externalAccountId] of accounts) {
        const values = {
          status: "active" as const,
          displayName: channel === "messenger" ? "Meta test Page" : "Meta test Instagram",
          config: {
            pageId,
            pageName: null,
            instagramAccountId: instagramId,
            instagramUsername: null,
          },
          connectedAt: new Date(),
        };
        const [row] = await ctx.tx
          .insert(channelConnections)
          .values({ ...ctx.tenant, channel, externalAccountId, ...values })
          .onConflictDoUpdate({
            target: [channelConnections.channel, channelConnections.externalAccountId],
            set: values,
            // Never take over another business's Page.
            setWhere: eq(channelConnections.businessId, ctx.tenant.businessId),
          })
          .returning({ id: channelConnections.id });
        if (row === undefined)
          throw new Error(`${channel} ${externalAccountId} belongs to another business.`);
        await db.secrets.channel.write(ctx, row.id, { pageAccessToken: token });
        console.log(`Connected ${channel} ${externalAccountId} (connection ${row.id}).`);
      }
    });
  } finally {
    await db.close();
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      business: { type: "string" },
      to: { type: "string" },
      instagram: { type: "boolean", default: false },
    },
  });
  if (positionals[0] === "connect") {
    if (values.business === undefined) {
      throw new Error(
        "Usage: pnpm --filter @repo/channel-messenger-instagram live:check connect --business <id>",
      );
    }
    await connect(values.business);
    return;
  }
  if (positionals[0] === "send") {
    if (values.to === undefined) {
      throw new Error(
        "Usage: pnpm --filter @repo/channel-messenger-instagram live:check send --to <PSID or IGSID> [--instagram]",
      );
    }
    await send(values.to, values.instagram);
    return;
  }
  await check();
}

main().catch((error: unknown) => {
  console.error(describe(error));
  process.exitCode = 1;
});
