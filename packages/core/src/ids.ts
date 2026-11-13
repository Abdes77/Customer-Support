import { z } from "zod";

/**
 * Branded identifiers. Every id is a UUID string at runtime; the brand stops a conversation id
 * from being passed where a business id is expected, which is the classic cross-tenant bug.
 * Parse untrusted input with the schema; cast trusted database values with `as BusinessId`.
 */
function brandedId<const Brand extends string>(brand: Brand) {
  return z.uuid().describe(brand).brand<Brand>();
}

export const AgencyId = brandedId("AgencyId");
export type AgencyId = z.infer<typeof AgencyId>;

export const BusinessId = brandedId("BusinessId");
export type BusinessId = z.infer<typeof BusinessId>;

export const UserId = brandedId("UserId");
export type UserId = z.infer<typeof UserId>;

export const SegmentId = brandedId("SegmentId");
export type SegmentId = z.infer<typeof SegmentId>;

export const ChannelConnectionId = brandedId("ChannelConnectionId");
export type ChannelConnectionId = z.infer<typeof ChannelConnectionId>;

export const ContactId = brandedId("ContactId");
export type ContactId = z.infer<typeof ContactId>;

export const ConversationId = brandedId("ConversationId");
export type ConversationId = z.infer<typeof ConversationId>;

export const MessageId = brandedId("MessageId");
export type MessageId = z.infer<typeof MessageId>;

export const LeadId = brandedId("LeadId");
export type LeadId = z.infer<typeof LeadId>;

export const IntegrationConnectionId = brandedId("IntegrationConnectionId");
export type IntegrationConnectionId = z.infer<typeof IntegrationConnectionId>;

/** Correlates one inbound message with its model calls, actions and outbound sends. */
export const TraceId = brandedId("TraceId");
export type TraceId = z.infer<typeof TraceId>;

export function newTraceId(): TraceId {
  return globalThis.crypto.randomUUID() as TraceId;
}

/** ISO 8601 timestamp with offset, for example 2026-11-11T18:30:00.000Z. */
export const IsoDateTime = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTime>;
