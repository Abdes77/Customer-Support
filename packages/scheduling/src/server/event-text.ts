import { type AppSettings, renderTemplate } from "@repo/settings";

import type { EventAttendee, EventDraft } from "../calendars/types";
import { meetingLabel } from "../time";
import { publicUrl, SCHEDULING_ROUTES } from "./deps";
import type { ConversationFacts } from "./facts";

/*
 * The calendar event the business owner reads. Everything that came from the customer (their
 * name, details and the lead report, which quotes them) is plain data: control characters
 * removed, angle brackets replaced so no calendar renders it as markup, web addresses written
 * so no calendar turns them into links ("evil[.]com", "https[:]//"), each value on its own
 * line and capped. Outlook gets the description as text; Google renders some HTML in
 * descriptions, which the replaced brackets keep inert.
 *
 * A guest sees the description too: when the customer is invited, the lead report (the
 * team's own assessment of them) stays out of it and the conversation link points to it.
 */

const MEETING_TYPES: Readonly<Record<AppSettings["scheduling.meeting_type"], string>> = {
  onsite_estimate: "On-site estimate",
  phone_call: "Phone call",
  video_call: "Video call",
  showroom_visit: "Showroom visit",
};

export function meetingTypeLabel(values: Pick<AppSettings, "scheduling.meeting_type">): string {
  return MEETING_TYPES[values["scheduling.meeting_type"]];
}

/** One line of customer-written text, safe to show as data. */
export function plainLine(value: string | null | undefined, max = 200): string {
  if (value === null || value === undefined) return "";
  const cleaned = value.replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g,
    " ",
  );
  const text = defang(
    cleaned.replace(/</g, "\u2039").replace(/>/g, "\u203a").replace(/\s+/g, " ").trim(),
  );
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const SCHEME = /\b([a-z][a-z0-9+.-]{1,20}):\/\//gi;
const WWW = /\bwww\./gi;
/** A host name a calendar could turn into a link ("evil.com", "login.evil.co"), not an email's. */
const HOST =
  /(?<![@\w.-])((?:[a-z0-9-]+\.)*[a-z0-9-]+)\.(com|net|org|io|co|us|biz|info|me|ly|app|xyz|link|site|online|top|ru|cn|gl|gg|to|tk)\b/gi;

/** Customer-written web addresses made inert, still readable by a person. */
export function defang(text: string): string {
  return text.replace(SCHEME, "$1[:]//").replace(WWW, "www[.]").replace(HOST, "$1[.]$2");
}

/** A block of customer-quoting text (the lead report), kept line by line. */
export function plainBlock(value: string, maxLines = 80, maxLength = 6000): string {
  const lines = value
    .split(/\r?\n/)
    .map((line) => plainLine(line, 300))
    .slice(0, maxLines);
  const text = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

const LOOKS_LIKE_EMAIL = /^[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}$/i;

export function eventDraft(input: {
  readonly facts: ConversationFacts;
  readonly values: AppSettings;
  readonly start: Date;
  readonly end: Date;
  readonly appUrl: string;
  readonly botName: string;
}): EventDraft {
  const { facts, values } = input;
  const name = plainLine(facts.customer.name, 80);
  const meeting = meetingTypeLabel(values);
  const title = plainLine(
    renderTemplate(values["scheduling.event_title"], {
      meeting_type: meeting,
      contact_name: name.length > 0 ? name : "New customer",
      service: plainLine(facts.customer.service, 60) || "service request",
      business_name: facts.business.name,
    }),
    200,
  );
  const when = meetingLabel({
    start: input.start,
    arrivalWindowMinutes: values["scheduling.arrival_window_minutes"],
    timeZone: facts.business.timeZone,
    businessTimeZone: facts.business.timeZone,
  });
  const detail = (label: string, value: string | null) => {
    const text = plainLine(value);
    return text.length > 0 ? `${label}: ${text}` : null;
  };
  const lines: (string | null)[] = [
    `${meeting}, ${when}. Booked by ${plainLine(input.botName, 60)} in a ${facts.channel} conversation.`,
    values["scheduling.arrival_window_minutes"] === null
      ? null
      : `Arrival window of ${values["scheduling.arrival_window_minutes"]} minutes, then about ${values["scheduling.slot_minutes"]} minutes.`,
    "",
    "Customer (as they gave it):",
    detail("Name", facts.customer.name),
    detail("Phone", facts.customer.phone),
    detail("Email", facts.customer.email),
    detail("Address", facts.customer.address),
    detail("Service", facts.customer.service),
  ];
  const email = facts.customer.email?.trim() ?? null;
  const attendees: EventAttendee[] =
    values["scheduling.invite_customer"] &&
    email !== null &&
    LOOKS_LIKE_EMAIL.test(email) &&
    email.length <= 254
      ? [{ email, name: name.length > 0 ? name : null }]
      : [];
  if (values["scheduling.include_report"]) {
    if (facts.report !== null) {
      lines.push(
        "",
        ...(attendees.length > 0
          ? ["Lead report: in the conversation (the customer is a guest and sees this text)."]
          : ["Lead report:", plainBlock(facts.report.markdown)]),
      );
    }
    lines.push(
      "",
      `Conversation: ${publicUrl(input.appUrl, SCHEDULING_ROUTES.conversation(facts.conversationId))}`,
    );
  }
  const location =
    values["scheduling.meeting_type"] === "onsite_estimate"
      ? plainLine(facts.customer.address, 200) || null
      : null;
  return {
    title,
    description: lines.filter((line): line is string => line !== null).join("\n"),
    location,
    start: input.start,
    end: input.end,
    timeZone: facts.business.timeZone,
    attendees,
  };
}
