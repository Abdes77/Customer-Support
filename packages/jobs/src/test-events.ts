import { randomUUID } from "node:crypto";

import type { EventPayload } from "@repo/core";

import { type JobEvent, jobEvent } from "./events";

/**
 * Builds a valid `message.received` event for tests of this package. Not exported from the
 * package entry point.
 */
export function sampleReceivedEvent(
  overrides: Partial<EventPayload<"message.received">> = {},
  id: string = randomUUID(),
): JobEvent<"message.received"> {
  return jobEvent("message.received", `test-${id}`, {
    traceId: randomUUID(),
    agencyId: randomUUID(),
    businessId: randomUUID(),
    conversationId: randomUUID(),
    messageId: randomUUID(),
    channel: "test",
    receivedAt: new Date().toISOString(),
    ...overrides,
  } as EventPayload<"message.received">);
}
