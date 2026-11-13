"use server";

import { randomUUID } from "node:crypto";

import { z } from "zod";

import { buildTestWebhookRequest, testAccountIdFor } from "@repo/channel-test";
import { ensureTestConnection, loadTestChat, type TestChatView } from "@repo/channel-test/server";
import { BusinessId, logger } from "@repo/core";
import { getEnv } from "@repo/core/env";
import { businesses, eq, getDatabase } from "@repo/db";

import { assertSameOrigin } from "@/server/admin";
import { requireAccess, requireBusinessRole, userDatabase } from "@/server/auth";
import { getServerPipeline } from "@/server/pipeline";

const VisitorId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const SendInput = z.object({
  businessId: BusinessId,
  visitorId: VisitorId,
  text: z.string().trim().min(1).max(2000),
});
const LoadInput = z.object({ businessId: BusinessId, visitorId: VisitorId });

export type SendTestMessageResult =
  { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * The business, if the signed-in user is agency staff for it. The dev chat writes a test
 * connection and acts as a customer, so client users may not use it.
 */
async function staffBusiness(businessId: BusinessId) {
  const { user, access } = await requireAccess("/dev/chat");
  const [business] = await userDatabase(user).run(({ tx }) =>
    tx
      .select({ id: businesses.id, agencyId: businesses.agencyId })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1),
  );
  if (business === undefined) return null;
  const tenant = { businessId: business.id, agencyId: business.agencyId };
  requireBusinessRole(access, tenant, ["agency_admin", "agency_member"]);
  return { user, tenant };
}

/** Sends one customer message to the business through the test channel's webhook path. */
export async function sendTestMessage(input: unknown): Promise<SendTestMessageResult> {
  const parsed = SendInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Type a message of up to 2,000 characters." };
  const { businessId, visitorId, text } = parsed.data;
  // The admin panel's cross-site rule (C15): this action writes as the signed-in person.
  try {
    await assertSameOrigin();
  } catch {
    return { ok: false, error: "That request did not come from this site. Reload the page." };
  }
  const found = await staffBusiness(businessId);
  if (found === null) return { ok: false, error: "That business was not found." };

  const server = getServerPipeline();
  if (server.testChannel === null) {
    return { ok: false, error: "The test channel is not set up on this deployment." };
  }
  await getDatabase()
    .forBusiness(found.tenant.businessId, { agencyId: found.tenant.agencyId })
    .run((ctx) => ensureTestConnection(ctx));
  const request = buildTestWebhookRequest({
    secret: server.testChannel.secret,
    url: `${getEnv().APP_URL ?? "http://localhost:3000"}/api/webhooks/test`,
    body: {
      accountId: testAccountIdFor(businessId),
      events: [
        {
          type: "message",
          id: `dev-${randomUUID()}`,
          from: { id: visitorId, name: "Test visitor" },
          text,
          sentAt: new Date().toISOString(),
        },
      ],
    },
  });
  const response = await server.pipeline.handleWebhook("test", request);
  if (response.status !== 200) {
    logger.warn("dev_chat.send_failed", { businessId, status: response.status });
    return { ok: false, error: "The message could not be delivered. Check the server log." };
  }
  return { ok: true };
}

/** The visitor's latest test conversation, as the signed-in user may see it. */
export async function loadTestConversation(input: unknown): Promise<TestChatView> {
  const parsed = LoadInput.safeParse(input);
  if (!parsed.success) return { conversationId: null, messages: [] };
  const found = await staffBusiness(parsed.data.businessId);
  if (found === null) return { conversationId: null, messages: [] };
  return userDatabase(found.user).run((ctx) =>
    loadTestChat(ctx, { businessId: parsed.data.businessId, visitorId: parsed.data.visitorId }),
  );
}
