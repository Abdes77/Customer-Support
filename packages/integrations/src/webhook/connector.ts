import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  type ConnectorContext,
  type ConnectorError,
  err,
  type IntegrationConnector,
  type LeadSyncPayload,
  ok,
  type Result,
  type ExternalRecord,
} from "@repo/core";

import { connectorError, errorForStatus } from "../http";
import { UnsafeTargetError } from "../net/safe-post";
import { signWebhookBody } from "./sign";

/*
 * The generic signed outgoing webhook (Zapier, Make, the agency's own systems). One
 * connection row per target and business holds the target's status; the signing secret is
 * the connection's (a business target) or the agency's (an agency-wide target). The body is
 * the canonical payload as JSON, the request is signed (`sign.ts`), and `context.fetch` is the
 * guarded poster (`net/safe-post.ts`): HTTPS only, public addresses only, no redirects.
 */

export const WebhookCredentials = z.object({ signingSecret: z.string().min(16) });
export type WebhookCredentials = z.infer<typeof WebhookCredentials>;

export const WebhookConfig = z.object({
  name: z.string().min(1).max(60),
  url: z.string().min(1).max(1000),
  scope: z.enum(["business", "agency"]),
});
export type WebhookConfig = z.infer<typeof WebhookConfig>;

export const WEBHOOK_USER_AGENT = "HomeServicesReplyBot-Webhooks/1.0";

/** The body a receiver gets. Field names are stable: receivers build on them. */
export function webhookBody(
  payload: LeadSyncPayload,
  deliveryId: string,
  now: Date,
): Record<string, unknown> {
  return {
    id: deliveryId,
    type: payload.lead.trigger ?? "lead.updated",
    createdAt: now.toISOString(),
    business: { id: payload.business.id, name: payload.business.name },
    lead: {
      id: payload.lead.id,
      status: payload.lead.status,
      score: payload.lead.score,
      band: payload.lead.band,
      routing: payload.lead.routing,
      fields: payload.lead.fields,
      createdAt: payload.lead.createdAt,
      updatedAt: payload.lead.updatedAt,
    },
    report: payload.lead.report,
    contact: {
      name: payload.contact.name,
      firstName: payload.contact.firstName ?? null,
      lastName: payload.contact.lastName ?? null,
      phone: payload.contact.phone,
      email: payload.contact.email,
      address: payload.contact.address,
      postalCode: payload.contact.postalCode ?? null,
    },
    conversation: {
      id: payload.conversation.id,
      channel: payload.conversation.channel,
      url: payload.conversation.url,
    },
    booking: payload.booking ?? null,
    ...(payload.transcript === undefined || payload.transcript === null
      ? {}
      : { transcript: payload.transcript }),
  };
}

function failureFor(error: unknown): ConnectorError {
  if (error instanceof UnsafeTargetError) {
    return connectorError(
      error.retryable ? "unavailable" : "validation",
      `The webhook address was not used: ${error.message}`,
      { retryable: error.retryable },
    );
  }
  return connectorError("unavailable", "The webhook address could not be reached.", {
    retryable: true,
  });
}

async function send(
  context: ConnectorContext<WebhookCredentials, WebhookConfig>,
  event: string,
  deliveryId: string,
  body: Record<string, unknown>,
): Promise<Result<ExternalRecord, ConnectorError>> {
  const raw = JSON.stringify(body);
  let response: Response;
  try {
    response = await context.fetch(context.config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": WEBHOOK_USER_AGENT,
        "x-hsrb-event": event,
        "x-hsrb-delivery": deliveryId,
        "idempotency-key": deliveryId,
        "x-hsrb-signature": signWebhookBody(context.credentials.signingSecret, raw, context.now()),
      },
      body: raw,
      redirect: "manual",
    });
  } catch (error) {
    return err(failureFor(error));
  }
  if (response.status >= 200 && response.status < 300) {
    return ok({ externalId: deliveryId, externalUrl: null });
  }
  if (response.status >= 300 && response.status < 400) {
    return err(
      connectorError(
        "validation",
        `The webhook address answered with a redirect (${response.status}); redirects are not followed. Use the final address.`,
        { retryable: false },
      ),
    );
  }
  return err(
    errorForStatus(
      `Webhook "${context.config.name}"`,
      response.status,
      null,
      response.headers,
      context.now().getTime(),
    ),
  );
}

export function createWebhookConnector(): IntegrationConnector<WebhookCredentials, WebhookConfig> {
  return {
    id: "webhook",
    displayName: "Webhook (Zapier, Make, your own systems)",
    auth: { type: "none" },
    credentialsSchema: WebhookCredentials,
    configSchema: WebhookConfig,
    defaultFieldMapping: [],

    async testConnection(context) {
      const id = randomUUID();
      const result = await send(context, "ping", id, {
        id,
        type: "ping",
        createdAt: context.now().toISOString(),
      });
      return result.ok ? ok({ accountLabel: context.config.name }) : result;
    },

    pushLead(context, payload, options) {
      const body = webhookBody(payload, options.idempotencyKey, context.now());
      return send(context, String(body["type"]), options.idempotencyKey, body);
    },

    updateLead(context, _externalId, payload, options) {
      const body = webhookBody(payload, options.idempotencyKey, context.now());
      return send(context, String(body["type"]), options.idempotencyKey, body);
    },
  };
}
