"use server";

import { z } from "zod";

import { type ActionResult, getAdminSettings, runAction } from "@/server/admin";
import { ActionError } from "@/server/admin/result";
import { ScreenTarget } from "@/server/admin/settings-actions";
import { getHandoff } from "@/server/handoff";

const TESTABLE = ["alerts.recipients", "emergency.escalation_chain"] as const;

const TestInput = z.strictObject({
  target: ScreenTarget,
  key: z.enum(TESTABLE),
  index: z.number().int().min(0).max(100),
});

const STATUS_WORDS: Readonly<Record<string, string>> = {
  sent: "sent",
  delivered: "delivered",
  failed: "failed",
  skipped: "not sent",
};

/**
 * Sends a test alert to one alert contact (C13's `sendTestAlert`). The browser names the
 * contact by its position; the address itself is read on the server and never sent back.
 */
export async function sendTestAlertAction(input: unknown): Promise<ActionResult<string>> {
  return runAction("alerts.test", async (session) => {
    const parsed = TestInput.safeParse(input);
    if (!parsed.success || parsed.data.target.scope !== "business") {
      throw new ActionError("Test alerts are sent for one business's contacts.");
    }
    const { scope, value } = await getAdminSettings().entryAt(
      session,
      parsed.data.target,
      parsed.data.key,
      parsed.data.index,
    );
    if (scope.scope !== "business") throw new ActionError("Unknown business.");
    const contact = value as {
      name?: string;
      email?: string;
      phone?: string;
      channels?: string[];
      alert_by?: string[];
    };
    const channels = (contact.channels ?? contact.alert_by ?? []).filter(
      (channel): channel is "email" | "sms" | "whatsapp" =>
        channel === "email" || channel === "sms" || channel === "whatsapp",
    );
    const { results } = await getHandoff().sendTestAlert({
      tenant: { agencyId: scope.agencyId, businessId: scope.businessId },
      recipient: {
        name: contact.name ?? "Contact",
        email: contact.email ?? "",
        phone: contact.phone ?? "",
        channels,
      },
      userId: session.user.id,
    });
    if (results.length === 0)
      return "Nothing to send: this contact has no address for its alert channels.";
    return `Test alert: ${results
      .map((result) => `${result.channel} ${STATUS_WORDS[result.status] ?? result.status}`)
      .join(", ")}.`;
  });
}
