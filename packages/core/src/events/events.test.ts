import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { EVENT_CATALOG, EVENT_NAMES, type EventPayload } from "./index";

const ids = {
  traceId: "0b9b6d1c-2a51-4d0e-9a55-0d0f6a4f3a01",
  agencyId: "3f2b8c1e-7d4a-4b6f-8e21-5c9a7d1e2f02",
  businessId: "9a1c3e5f-2b4d-4f6a-8c0e-1d3f5a7b9c03",
  conversationId: "5d7f9b1c-3e5a-4c7e-9a1b-2c4e6f8a0b04",
  contactId: "7e9a1c3d-5f7b-4d9f-8b3d-4e6f8a0c2d05",
  leadId: "1c3e5a7b-9d1f-4b3d-a5f7-6a8c0e2f4b06",
  messageId: "2d4f6b8c-0e2a-4c4e-b6a8-7b9d1f3a5c07",
} as const;

const leadBase = {
  eventId: "8f0a2c4e-6b8d-4f0b-a2c4-8c0e2a4b6d08",
  occurredAt: "2026-11-11T18:30:00.000Z",
  traceId: ids.traceId,
  agencyId: ids.agencyId,
  businessId: ids.businessId,
  conversationId: ids.conversationId,
  contactId: ids.contactId,
  leadId: ids.leadId,
  channel: "whatsapp",
  score: 82,
  band: "hot",
} as const;

const pipelineBase = {
  traceId: ids.traceId,
  agencyId: ids.agencyId,
  businessId: ids.businessId,
  conversationId: ids.conversationId,
} as const;

const samples: { [TName in keyof typeof EVENT_CATALOG]: unknown } = {
  "message.received": {
    ...pipelineBase,
    messageId: ids.messageId,
    channel: "whatsapp",
    receivedAt: "2026-11-11T18:30:00.000Z",
  },
  "message.send_requested": { ...pipelineBase, messageId: ids.messageId, channel: "email" },
  "message.send_failed": {
    ...pipelineBase,
    messageId: ids.messageId,
    channel: "messenger",
    errorCode: "window_closed",
  },
  "conversation.takeover_started": { ...pipelineBase, userId: null, source: "provider_inbox" },
  "conversation.takeover_released": { ...pipelineBase, userId: null, source: "idle_timeout" },
  "lead.qualified": { ...leadBase, routing: "book_meeting" },
  "lead.meeting_requested": { ...leadBase, bookingMode: "calendar" },
  "lead.handoff": { ...leadBase, routing: "contact_later", trigger: "routing", urgency: "normal" },
  "lead.disqualified": { ...leadBase, reasonCode: "out_of_area" },
  "lead.emergency": { ...leadBase, emergencyClass: "gas_leak" },
  "playbook.generation_requested": {
    traceId: ids.traceId,
    agencyId: ids.agencyId,
    segmentId: "4b6d8f0a-2c4e-4a6c-8e0a-9d1f3b5c7e09",
    generationId: "6c8e0a2c-4e6a-4c8e-a0c2-0e2a4c6e8a10",
    // Null when an admin asked for the playbook outside an onboarding.
    businessId: null,
  },
  "knowledge.import_requested": {
    traceId: ids.traceId,
    agencyId: ids.agencyId,
    businessId: ids.businessId,
    importRunId: "0a2c4e6a-8c0e-4e2a-a4e6-2a4c6e8a0c11",
  },
  "email.sync_requested": {
    traceId: ids.traceId,
    agencyId: ids.agencyId,
    businessId: ids.businessId,
    connectionId: "3c5e7a9c-1e3a-4c5e-a7c9-4e6a8c0e2a12",
    reason: "push",
  },
  "scheduling.booking_changed": {
    traceId: ids.traceId,
    agencyId: ids.agencyId,
    businessId: ids.businessId,
    bookingId: "4d6f8b0d-2f4b-4d6f-b8d0-5f7b9d1f3b13",
    version: 2,
    change: "moved",
  },
  "conversation.turn_requested": {
    ...pipelineBase,
    trigger: "follow_up",
    requestId: "follow-up-5e7a9c1e-3a5c-4e7a-9c1e-6a8c0e2a4c14",
  },
  "handoff.escalation_started": {
    traceId: ids.traceId,
    agencyId: ids.agencyId,
    businessId: ids.businessId,
    escalationId: "6f8b0d2f-4b6d-4f8b-a0d2-7b9d1f3b5d15",
  },
  "handoff.follow_up_planned": {
    ...pipelineBase,
    followUpId: "7a9c1e3a-5c7e-4a9c-b1e3-8c0e2a4c6e16",
  },
  "handoff.attention_needed": {
    ...pipelineBase,
    reason: "opted_out_customer_wrote",
    day: "2026-11-10",
  },
  "integrations.delivery_requested": {
    traceId: ids.traceId,
    agencyId: ids.agencyId,
    businessId: ids.businessId,
    connectionId: "8b0d2f4b-6d8f-4b0d-a2f4-9d1f3b5d7f17",
    deliveryId: "9c1e3a5c-7e9a-4c1e-b3a5-0e2a4c6e8a18",
  },
};

describe("event catalogue", () => {
  it("contains the five lead events named in the spec", () => {
    expect(EVENT_NAMES).toEqual(
      expect.arrayContaining([
        "lead.qualified",
        "lead.meeting_requested",
        "lead.handoff",
        "lead.disqualified",
        "lead.emergency",
      ]),
    );
  });

  it("names events as lower-case entity.event", () => {
    for (const name of EVENT_NAMES) expect(name).toMatch(/^[a-z]+\.[a-z_]+$/);
  });

  it.each(EVENT_NAMES)("accepts a valid %s payload", (name) => {
    const result = EVENT_CATALOG[name].safeParse(samples[name]);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it.each(EVENT_NAMES)("%s carries the tenant and the trace", (name) => {
    for (const key of ["agencyId", "businessId", "traceId"]) {
      const broken = { ...(samples[name] as Record<string, unknown>), [key]: undefined };
      expect(EVENT_CATALOG[name].safeParse(broken).success, key).toBe(false);
    }
  });

  it.each(EVENT_NAMES)("%s carries no customer text or contact details", (name) => {
    const schema: z.ZodType = EVENT_CATALOG[name];
    const keys = Object.keys((schema as z.ZodObject).shape);
    const forbidden = [
      "text",
      "body",
      "html",
      "subject",
      "phone",
      "email",
      "name",
      "summary",
      "report",
    ];
    expect(keys.filter((key) => forbidden.includes(key))).toEqual([]);
  });

  it("rejects ids that are not UUIDs", () => {
    const bad = { ...(samples["lead.qualified"] as object), businessId: "acme-roofing" };
    expect(EVENT_CATALOG["lead.qualified"].safeParse(bad).success).toBe(false);
  });

  it("infers typed payloads from the catalogue", () => {
    const payload: EventPayload<"lead.emergency"> = EVENT_CATALOG["lead.emergency"].parse(
      samples["lead.emergency"],
    );
    expect(payload.emergencyClass).toBe("gas_leak");
  });
});
