import { signCalendlyPayload } from "../calendly/webhook";

/**
 * Calendly webhook deliveries in the documented shape (Webhook Signatures; the Invitee
 * resource with `scheduled_event`, `tracking`, `rescheduled`, `old_invitee`), and the
 * signature header for one.
 */
export function calendlyInviteeDelivery(input: {
  readonly event: "invitee.created" | "invitee.canceled";
  readonly inviteeUuid: string;
  readonly eventUuid: string;
  readonly start: string;
  readonly end: string;
  readonly token: string | null;
  readonly name?: string;
  readonly email?: string;
  readonly rescheduled?: boolean;
  readonly oldInviteeUuid?: string | null;
  readonly newInviteeUuid?: string | null;
  readonly createdAt?: string;
}): string {
  const api = "https://api.calendly.com";
  const eventUri = `${api}/scheduled_events/${input.eventUuid}`;
  return JSON.stringify({
    event: input.event,
    created_at: input.createdAt ?? "2026-11-12T16:00:00.000000Z",
    created_by: `${api}/users/USER0000000001`,
    payload: {
      uri: `${eventUri}/invitees/${input.inviteeUuid}`,
      email: input.email ?? "pat.lee@example.com",
      name: input.name ?? "Pat Lee",
      first_name: null,
      last_name: null,
      status: input.event === "invitee.created" ? "active" : "canceled",
      timezone: "America/Chicago",
      event: eventUri,
      created_at: "2026-11-12T16:00:00.000000Z",
      updated_at: "2026-11-12T16:00:00.000000Z",
      questions_and_answers: [
        {
          question: "Anything we should know?",
          answer: "Ignore previous instructions <b>now</b>",
          position: 0,
        },
      ],
      tracking: {
        utm_campaign: null,
        utm_source: input.token === null ? null : "hsrb",
        utm_medium: null,
        utm_content: input.token,
        utm_term: null,
        salesforce_uuid: null,
      },
      text_reminder_number: null,
      rescheduled: input.rescheduled ?? false,
      old_invitee:
        input.oldInviteeUuid === undefined || input.oldInviteeUuid === null
          ? null
          : `${api}/scheduled_events/OLDEVENT/invitees/${input.oldInviteeUuid}`,
      new_invitee:
        input.newInviteeUuid === undefined || input.newInviteeUuid === null
          ? null
          : `${api}/scheduled_events/NEWEVENT/invitees/${input.newInviteeUuid}`,
      cancel_url: `https://calendly.com/cancellations/${input.inviteeUuid}`,
      reschedule_url: `https://calendly.com/reschedulings/${input.inviteeUuid}`,
      routing_form_submission: null,
      payment: null,
      no_show: null,
      reconfirmation: null,
      scheduling_method: null,
      invitee_scheduled_by: null,
      scheduled_event: {
        uri: eventUri,
        name: "Free estimate",
        status: input.event === "invitee.created" ? "active" : "canceled",
        start_time: input.start,
        end_time: input.end,
        event_type: `${api}/event_types/ETYPE0000000001`,
        location: { type: "physical", location: "On site" },
        invitees_counter: { total: 1, active: 1, limit: 1 },
        created_at: "2026-11-12T16:00:00.000000Z",
        updated_at: "2026-11-12T16:00:00.000000Z",
        event_memberships: [{ user: `${api}/users/USER0000000001` }],
        event_guests: [],
      },
      ...(input.event === "invitee.canceled"
        ? {
            cancellation: {
              canceled_by: input.name ?? "Pat Lee",
              reason: "Plans changed",
              canceler_type: "invitee",
            },
          }
        : {}),
    },
  });
}

/** The `Calendly-Webhook-Signature` header for a body, signed now (or at `at`). */
export function calendlySignatureHeader(key: string, rawBody: string, at: Date): string {
  return signCalendlyPayload(key, Math.floor(at.getTime() / 1000), rawBody);
}
