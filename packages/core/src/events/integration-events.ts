import { z } from "zod";

import { AgencyId, BusinessId, IntegrationConnectionId, TraceId } from "../ids";

/**
 * Integration events (owner: C14). Ids only, at-least-once delivery, consumers idempotent.
 */

/**
 * One delivery to a CRM connection or an outgoing webhook target is due: its row in
 * `integration_events` is the journal (status, attempts, the external id). Emitted when a
 * lead event or a booking change is planned, by the sweeper for a delivery whose run was
 * lost, and when a person retries a failed delivery from the admin panel.
 */
export const IntegrationDeliveryRequestedEvent = z.object({
  traceId: TraceId,
  agencyId: AgencyId,
  businessId: BusinessId,
  connectionId: IntegrationConnectionId,
  deliveryId: z.uuid(),
});
export type IntegrationDeliveryRequestedEvent = z.infer<typeof IntegrationDeliveryRequestedEvent>;

export const INTEGRATION_EVENTS = {
  "integrations.delivery_requested": IntegrationDeliveryRequestedEvent,
} as const;
