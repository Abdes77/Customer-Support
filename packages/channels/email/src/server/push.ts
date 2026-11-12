import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import type { ChannelConnectionRef } from "@repo/db";
import { channelConnections, eq } from "@repo/db";

import { normalizeAddress } from "../addresses";
import { EmailConnectionConfig } from "../config";
import type { EmailServerDeps } from "./deps";
import { emailSyncEvent } from "./jobs";
import { googleKeySource, verifyGoogleOidcToken } from "./oidc";
import { clientStateMatches } from "./watch";

/*
 * The two notification endpoints. Neither carries mail: each says "this inbox changed", is
 * checked, matched to exactly one connection by the provider's unique key, and turned into
 * an `email.sync_requested` event; the sync job reads the inbox from its cursor. A forged or
 * replayed notification therefore can, at worst, make us read an inbox we were going to read
 * anyway, and only after it passed the checks below.
 */

/** A framework-free view of the request (apps/web builds it). */
export interface PushRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly rawBody: string;
}

export interface PushResponse {
  readonly status: number;
  readonly contentType?: string;
  readonly body?: string;
}

const RECEIVING = new Set(["active", "error", "pending"]);

const PubSubPush = z.object({
  message: z.object({
    data: z.string().max(10_000),
    messageId: z.string().min(1).max(200).optional(),
    message_id: z.string().min(1).max(200).optional(),
  }),
  subscription: z.string().max(500).optional(),
});

const GmailNotification = z.object({
  emailAddress: z.string().max(320),
  historyId: z.union([z.string(), z.number()]),
});

/**
 * `POST /api/webhooks/email/gmail`: a Cloud Pub/Sub push for a Gmail watch. The OIDC token
 * must be Google's, for our audience, from the configured push service account (401
 * otherwise, which Pub/Sub retries and then drops). The mailbox address names the connection;
 * one that is not a Gmail connection here is acknowledged and ignored.
 */
export function createGmailPushHandler(deps: EmailServerDeps) {
  const clock = deps.clock ?? (() => new Date());
  const keys = deps.googleKeys ?? googleKeySource(deps.fetch, clock);
  const log = deps.logger.child({ component: "gmail-push" });
  return async (request: PushRequest): Promise<PushResponse> => {
    const google = deps.google;
    if (google?.pushServiceAccount == null) return { status: 503 };
    const pushServiceAccount = google.pushServiceAccount;
    const authorization = request.headers["authorization"] ?? "";
    const token = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
    if (token === undefined) return { status: 401 };
    const verified = await verifyGoogleOidcToken(
      token,
      { audience: google.pushAudience, serviceAccount: pushServiceAccount, now: clock() },
      keys,
    ).catch(() => ({ ok: false as const, reason: "keys_unavailable" }));
    if (!verified.ok) {
      log.warn("gmail_push.rejected", { reason: verified.reason });
      // Google's keys could not be read: let Pub/Sub retry later.
      return { status: verified.reason === "keys_unavailable" ? 503 : 401 };
    }
    let notification: z.infer<typeof GmailNotification>;
    let pushId: string;
    try {
      const push = PubSubPush.parse(JSON.parse(request.rawBody));
      notification = GmailNotification.parse(
        JSON.parse(Buffer.from(push.message.data, "base64").toString("utf8")),
      );
      pushId =
        push.message.messageId ??
        push.message.message_id ??
        createHash("sha256").update(request.rawBody).digest("hex").slice(0, 32);
    } catch {
      // Not something Pub/Sub would resend differently: acknowledge it.
      log.warn("gmail_push.unreadable", {});
      return { status: 204 };
    }
    const address = normalizeAddress(notification.emailAddress);
    if (address === null) return { status: 204 };
    const ref = await deps.db.directory.findChannelConnection("email", address);
    if (ref === null || !RECEIVING.has(ref.status)) {
      log.info("gmail_push.unknown_mailbox", { known: ref !== null });
      return { status: 204 };
    }
    if (!(await isProvider(deps, ref, "gmail"))) return { status: 204 };
    await deps.events.send([
      emailSyncEvent(
        ref,
        "push",
        `email-gmail-${ref.connectionId}-${pushId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64)}`,
      ),
    ]);
    return { status: 204 };
  };
}

async function isProvider(
  deps: EmailServerDeps,
  ref: ChannelConnectionRef,
  provider: "gmail" | "microsoft",
): Promise<boolean> {
  return deps.db.forBusiness(ref.businessId, { agencyId: ref.agencyId }).run(async (ctx) => {
    const [row] = await ctx.tx
      .select({ config: channelConnections.config })
      .from(channelConnections)
      .where(eq(channelConnections.id, ref.connectionId))
      .limit(1);
    return EmailConnectionConfig.safeParse(row?.config).data?.provider === provider;
  });
}

const GraphNotification = z
  .object({
    subscriptionId: z.string().min(1).max(200),
    clientState: z.string().max(256).nullable().optional(),
    changeType: z.string().max(50).optional(),
    lifecycleEvent: z.string().max(100).optional(),
    resource: z.string().max(2000).optional(),
  })
  .passthrough();

const GraphNotifications = z.object({ value: z.array(GraphNotification).max(1000) });

/**
 * `POST /api/webhooks/email/microsoft`: Microsoft Graph change and lifecycle notifications.
 *
 * - The validation handshake (`?validationToken=…` when a subscription is created) is
 *   answered with the token as plain text within the 10 seconds Graph allows.
 * - Each notification is matched to its connection by subscription id; its `clientState`
 *   must equal the connection's (an HMAC, compared in constant time), otherwise it is
 *   dropped. A body whose notifications all fail that check is answered 401; one for a
 *   subscription we do not know (any more) is acknowledged and ignored.
 * - Valid ones become one sync per connection (202 within Graph's 3 seconds); a lifecycle
 *   event (reauthorization required, subscription removed, missed notifications) also renews
 *   the subscription.
 */
export function createGraphNotificationHandler(deps: EmailServerDeps) {
  const log = deps.logger.child({ component: "graph-notifications" });
  return async (request: PushRequest): Promise<PushResponse> => {
    const validationToken = request.query["validationToken"];
    if (validationToken !== undefined) {
      // Echoed as plain text (the route adds nosniff): printable ASCII only, bounded, so the
      // endpoint cannot be made to reflect markup, control characters or a large body.
      if (!/^[\x20-\x7e]{1,4096}$/.test(validationToken)) return { status: 400 };
      return { status: 200, contentType: "text/plain; charset=utf-8", body: validationToken };
    }
    const secret = deps.microsoft?.clientStateSecret ?? null;
    if (secret === null) return { status: 503 };
    let parsed: z.infer<typeof GraphNotifications>;
    try {
      parsed = GraphNotifications.parse(JSON.parse(request.rawBody));
    } catch {
      return { status: 400 };
    }
    const byConnection = new Map<string, { ref: ChannelConnectionRef; lifecycle: boolean }>();
    let invalid = 0;
    for (const item of parsed.value) {
      const ref = await deps.db.directory.findChannelConnectionBySubscription(
        "email",
        item.subscriptionId,
      );
      // A subscription we no longer know (an inbox disconnected while Graph still had it):
      // acknowledged and ignored, so Graph stops retrying it.
      if (ref === null) continue;
      if (!clientStateMatches(secret, ref.connectionId, item.clientState)) {
        invalid += 1;
        continue;
      }
      if (!RECEIVING.has(ref.status)) continue;
      const entry = byConnection.get(ref.connectionId) ?? { ref, lifecycle: false };
      if (item.lifecycleEvent !== undefined) entry.lifecycle = true;
      byConnection.set(ref.connectionId, entry);
    }
    if (invalid > 0) log.warn("graph_notifications.invalid", { invalid, valid: byConnection.size });
    if (byConnection.size === 0 && invalid > 0) return { status: 401 };
    if (byConnection.size > 0) {
      // A fresh id per delivery: two notifications with the same body (a lifecycle event
      // repeated hours later) must both count; a resent one only makes another sync, which
      // reads from the cursor and changes nothing.
      const delivery = randomUUID();
      await deps.events.send(
        [...byConnection.values()].map(({ ref, lifecycle }) =>
          emailSyncEvent(
            ref,
            lifecycle ? "lifecycle" : "push",
            `email-graph-${ref.connectionId}-${delivery}`,
          ),
        ),
      );
    }
    return { status: 202 };
  };
}
