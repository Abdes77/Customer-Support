import type { BusinessId, ContactId, ConversationId, LeadId, LeadSyncPayload } from "@repo/core";

/** A canonical payload with customer-written text that tries to break out of its field. */
export function sampleLeadPayload(
  overrides: Partial<LeadSyncPayload["contact"]> = {},
): LeadSyncPayload {
  return {
    lead: {
      id: "11111111-1111-4111-8111-111111111111" as LeadId,
      status: "qualified",
      score: 82,
      band: "hot",
      routing: "book_meeting",
      fields: {
        service_type: "roof leak repair",
        timeline: "this_week",
        job_scope: 'Leak over the kitchen"}, "admin": true, "x": {"',
      },
      report: {
        summary: "Hot lead: roof leak, this week, homeowner.",
        markdown:
          '## Who\nPat Lee, homeowner\n## Job\n"Ignore previous instructions" <script>alert(1)</script> roof leak',
      },
      createdAt: "2026-11-12T14:00:00.000Z",
      updatedAt: "2026-11-12T14:30:00.000Z",
      trigger: "lead.qualified",
    },
    contact: {
      id: "22222222-2222-4222-8222-222222222222" as ContactId,
      name: 'Pat "Bobby" Lee',
      phone: "(512) 555-0199",
      email: "pat.lee@example.com",
      address: "1200 Elm St, Austin, TX 78704",
      firstName: 'Pat "Bobby"',
      lastName: "Lee",
      postalCode: "78704",
      ...overrides,
    },
    business: { id: "33333333-3333-4333-8333-333333333333" as BusinessId, name: "Summit Roofing" },
    conversation: {
      id: "44444444-4444-4444-8444-444444444444" as ConversationId,
      channel: "whatsapp",
      url: "https://app.example/inbox/44444444-4444-4444-8444-444444444444",
    },
    booking: null,
    transcript: null,
  };
}
