import { BUSINESS_ONLY, defineCategory, setting } from "../define";
import { f, sameHoursOn } from "../fields";
import { variables } from "../templates";

export const SCHEDULING_PROVIDERS = [
  "none",
  "google_calendar",
  "outlook_calendar",
  "calendly",
] as const;

/**
 * Calendars, slots, booking rules and reminders. Consumed by scheduling (C12: the
 * `offer_times` and `book_meeting` actions). Which calendar account is connected is an
 * integration connection, not a setting.
 */
export const schedulingSettings = defineCategory("scheduling", {
  "scheduling.provider": setting({
    label: "Booking through",
    help: "Where meetings are booked. With no calendar, a lead who should be booked is told the team will be in touch (see Routing).",
    field: f.select([
      ["none", "No calendar"],
      ["google_calendar", "Google Calendar"],
      ["outlook_calendar", "Outlook Calendar"],
      ["calendly", "Calendly", "The bot sends a one-time scheduling link."],
    ]),
    default: "none",
  }),
  "scheduling.meeting_type": setting({
    label: "Kind of meeting",
    help: "What a booked meeting is. The bot uses the name when it offers times.",
    field: f.select([
      ["onsite_estimate", "On-site estimate"],
      ["phone_call", "Phone call"],
      ["video_call", "Video call"],
      ["showroom_visit", "Showroom visit"],
    ]),
    default: "onsite_estimate",
    clientEditable: true,
  }),
  "scheduling.slot_minutes": setting({
    label: "Meeting length",
    help: "How long one meeting takes.",
    field: f.integer({ min: 10, max: 480, step: 5, unit: "minutes" }),
    default: 60,
    clientEditable: true,
  }),
  "scheduling.slot_interval_minutes": setting({
    label: "Start times every",
    help: "Meetings can start at multiples of this, counted from the start of each open interval. 30 gives 9:00, 9:30, 10:00.",
    field: f.integer({ min: 5, max: 240, step: 5, unit: "minutes" }),
    default: 30,
  }),
  "scheduling.buffer_before_minutes": setting({
    label: "Free time before a meeting",
    help: "Time kept free before each meeting, for travel and preparation.",
    field: f.integer({ min: 0, max: 240, step: 5, unit: "minutes" }),
    default: 0,
    clientEditable: true,
  }),
  "scheduling.buffer_after_minutes": setting({
    label: "Free time after a meeting",
    help: "Time kept free after each meeting.",
    field: f.integer({ min: 0, max: 240, step: 5, unit: "minutes" }),
    default: 30,
    clientEditable: true,
  }),
  "scheduling.min_lead_time_hours": setting({
    label: "Earliest booking",
    help: "A meeting can be booked no sooner than this many hours from now.",
    field: f.integer({ min: 0, max: 720, unit: "hours" }),
    default: 24,
    clientEditable: true,
  }),
  "scheduling.max_days_ahead": setting({
    label: "Latest booking",
    help: "A meeting can be booked no further ahead than this.",
    field: f.integer({ min: 1, max: 180, unit: "days" }),
    default: 14,
    clientEditable: true,
  }),
  "scheduling.hours_source": setting({
    label: "Meeting hours",
    help: "When meetings can take place.",
    field: f.select([
      ["business_hours", "During business hours"],
      ["custom", "During the meeting hours below"],
    ]),
    default: "business_hours",
    clientEditable: true,
  }),
  "scheduling.custom_hours": setting({
    label: "Custom meeting hours",
    help: "Used when meeting hours are set to custom.",
    field: f.weeklyHours(),
    default: sameHoursOn(
      ["monday", "tuesday", "wednesday", "thursday", "friday"],
      "09:00",
      "16:00",
    ),
    clientEditable: true,
  }),
  "scheduling.skip_holidays": setting({
    label: "No meetings on closed days",
    help: "Meetings are not offered on holidays and other closed days from the Hours category.",
    field: f.boolean(),
    default: true,
  }),
  "scheduling.slots_to_offer": setting({
    label: "Times to offer",
    help: "How many concrete times the bot offers at once.",
    field: f.integer({ min: 1, max: 5, unit: "times" }),
    default: 3,
  }),
  "scheduling.spread_offers": setting({
    label: "Spread the offered times",
    help: "The offered times fall on different days or different parts of the day where possible, instead of the next free slots in a row.",
    field: f.boolean(),
    default: true,
  }),
  "scheduling.max_meetings_per_day": setting({
    label: "Meetings per day",
    help: "No more than this many bot-booked meetings on one day.",
    field: f.nullable(f.integer({ min: 1, max: 50, unit: "meetings" }), "No limit"),
    default: null,
    clientEditable: true,
  }),
  "scheduling.arrival_window_minutes": setting({
    label: "Arrival window",
    help: 'For on-site visits: the bot offers a window ("between 9 and 11") of this length instead of an exact time. Empty offers exact times.',
    field: f.nullable(f.integer({ min: 30, max: 480, step: 30, unit: "minutes" }), "Exact times"),
    default: null,
    clientEditable: true,
  }),
  "scheduling.travel_rules": setting({
    label: "Travel rules by area",
    help: "Limits for parts of the service area: jobs in the listed ZIP codes are visited only on the listed days, with extra travel time added around the meeting.",
    field: f.list(
      f.object({
        name: { label: "Area", field: f.text({ minLength: 1, maxLength: 60 }) },
        zip_codes: {
          label: "ZIP codes",
          field: f.stringList({ itemLabel: "ZIP code", format: "zip", minItems: 1, maxItems: 500 }),
        },
        days: {
          label: "Visit days",
          field: f.multiSelect(
            ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
            { minItems: 1 },
          ),
        },
        extra_travel_minutes: {
          label: "Extra travel time",
          field: f.integer({ min: 0, max: 240, step: 5, unit: "minutes" }),
        },
      }),
      { itemLabel: "travel rule", maxItems: 30, unique: "name" },
    ),
    default: [],
    scopes: BUSINESS_ONLY,
    clientEditable: true,
  }),
  "scheduling.event_title": setting({
    label: "Calendar event title",
    help: "The title of the calendar event the bot creates.",
    field: f.text({
      minLength: 1,
      maxLength: 200,
      variables: variables("meeting_type", "contact_name", "service", "business_name"),
    }),
    default: "{{meeting_type}}: {{contact_name}} ({{service}})",
  }),
  "scheduling.include_report": setting({
    label: "Lead report in the calendar event",
    help: "The event description carries the lead report and a link to the conversation. A guest can read the description, so when the customer is invited it carries only the link.",
    field: f.boolean(),
    default: true,
  }),
  "scheduling.invite_customer": setting({
    label: "Invite the customer",
    help: "The customer is added to the calendar event as a guest when their email address is known.",
    field: f.boolean(),
    default: true,
  }),
  "scheduling.confirmation_guidance": setting({
    label: "Booking confirmation",
    help: "How the bot confirms a booked meeting. Guidance, not a script; the date, the time and the kind of meeting are always stated.",
    field: f.text({ multiline: true, minLength: 1, maxLength: 500 }),
    default:
      "Confirm the day, date and time in the customer's words, say what happens at the meeting and who is coming, and mention that they can reschedule right here if something comes up.",
  }),
  "scheduling.allow_reschedule": setting({
    label: "Rescheduling in the conversation",
    help: "Customers can move their meeting by asking the bot.",
    field: f.boolean(),
    default: true,
  }),
  "scheduling.allow_cancel": setting({
    label: "Cancelling in the conversation",
    help: "Customers can cancel their meeting by asking the bot. When off, the bot passes the request to the team.",
    field: f.boolean(),
    default: true,
  }),
  "scheduling.change_cutoff_hours": setting({
    label: "Changes until",
    help: "The bot reschedules or cancels up to this many hours before the meeting. Later requests go to the team.",
    field: f.integer({ min: 0, max: 168, unit: "hours" }),
    default: 2,
  }),
  "scheduling.reminders": setting({
    label: "Reminders",
    help: "The customer is reminded of a booked meeting.",
    field: f.boolean(),
    default: true,
  }),
  "scheduling.reminder_minutes_before": setting({
    label: "Remind before the meeting",
    help: "One reminder per entry, this many minutes before the meeting. 1440 is a day.",
    field: f.list(f.integer({ min: 10, max: 20_160, unit: "minutes" }), {
      itemLabel: "reminder",
      maxItems: 4,
      unique: true,
    }),
    default: [1440, 120],
  }),
  "scheduling.reminder_asks_confirmation": setting({
    label: "Reminders ask to confirm",
    help: "The first reminder asks the customer to confirm they will be there, and offers to reschedule.",
    field: f.boolean(),
    default: true,
  }),
  "scheduling.reminder_message": setting({
    label: "Reminder text",
    help: "What a reminder says. Sent as written, with the placeholders filled in.",
    field: f.text({
      multiline: true,
      minLength: 1,
      maxLength: 400,
      variables: variables("meeting_type", "meeting_time", "business_name", "bot_name"),
    }),
    default: "Just a reminder of your {{meeting_type}} with {{business_name}} on {{meeting_time}}.",
    clientEditable: true,
  }),
  "scheduling.reminder_confirm_message": setting({
    label: "Asking to confirm",
    help: "Added to the first reminder when reminders ask to confirm.",
    field: f.text({ multiline: true, minLength: 1, maxLength: 300 }),
    default:
      "Could you reply to confirm you'll be there? If something came up, just tell me here and we'll find another time.",
    clientEditable: true,
  }),
  "scheduling.tentative_events": setting({
    label: "Tentative calendar events",
    help: "Whether a tentative event in the connected calendar (not yet accepted, or shown as tentative) keeps that time from being offered.",
    field: f.select([
      ["busy", "Count as busy"],
      ["free", "Count as free"],
    ]),
    default: "busy",
  }),
  "scheduling.all_day_events": setting({
    label: "All-day calendar events",
    help: "How all-day events in the connected calendar (a day off, a holiday, a reminder) affect the times offered.",
    field: f.select([
      [
        "as_marked",
        "As marked in the calendar",
        "An all-day event blocks its days only when it is marked busy; Google and Outlook mark new all-day events free.",
      ],
      ["always_busy", "Always block the day"],
      ["ignore", "Never block the day"],
    ]),
    default: "as_marked",
  }),
  "scheduling.unbooked_alert_hours": setting({
    label: "Alert when no meeting is booked",
    help: "When a lead should be booked but no meeting is booked this many hours later, the team gets an alert in the admin panel. When no calendar is connected the alert comes at once, so a person books the meeting.",
    field: f.nullable(f.integer({ min: 1, max: 168, unit: "hours" }), "No alert"),
    default: 24,
  }),
  "scheduling.calendly_event_type": setting({
    label: "Calendly event type",
    help: "The address of the Calendly event type that scheduling links are created for, for example https://calendly.com/summit-roofing/estimate.",
    field: f.nullable(f.text({ format: "url", minLength: 1, maxLength: 300 }), "Not set"),
    default: null,
    scopes: BUSINESS_ONLY,
  }),
});
