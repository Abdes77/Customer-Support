import { defineCategory, setting } from "../define";
import { f, sameHoursOn } from "../fields";
import { variables } from "../templates";

export const AFTER_HOURS_MODES = [
  "normal",
  "set_expectations",
  "take_message",
  "auto_reply",
  "silent",
] as const;

/**
 * Business hours, holidays, after-hours behaviour and quiet hours. Consumed by the engine
 * (C4), scheduling (C12) and follow-ups (C13). Times are in the business's time zone, which
 * is a property of the business (`businesses.timezone`), not a setting.
 */
export const hoursSettings = defineCategory("hours", {
  "hours.weekly": setting({
    label: "Business hours",
    help: "When the office is open, per weekday. A day without hours is closed.",
    field: f.weeklyHours(),
    default: sameHoursOn(
      ["monday", "tuesday", "wednesday", "thursday", "friday"],
      "08:00",
      "17:00",
    ),
    clientEditable: true,
  }),
  "hours.us_federal_holidays": setting({
    label: "Closed on US federal holidays",
    help: "The business counts as closed on the federal holidays (New Year's Day, Memorial Day, Independence Day, Labor Day, Thanksgiving, Christmas Day and the others).",
    field: f.boolean(),
    default: true,
    clientEditable: true,
  }),
  "hours.holidays": setting({
    label: "Other closed days and special hours",
    help: "Days with different hours. Leave the hours empty for a day that is closed.",
    field: f.list(
      f.object({
        date: { label: "Date", field: f.text({ format: "date", minLength: 10 }) },
        name: { label: "Occasion", field: f.text({ maxLength: 80 }) },
        hours: {
          label: "Open",
          help: "Empty means closed all day.",
          field: f.list(
            f.object(
              {
                open: { label: "Opens", field: f.text({ format: "time", minLength: 5 }) },
                close: { label: "Closes", field: f.text({ format: "time", minLength: 5 }) },
              },
              {
                check: (interval) =>
                  interval.close > interval.open
                    ? []
                    : [
                        {
                          path: ["close"],
                          message: "The closing time must be later than the opening time.",
                        },
                      ],
              },
            ),
            { itemLabel: "open interval", maxItems: 4 },
          ),
        },
      }),
      { itemLabel: "day", maxItems: 120, unique: "date" },
    ),
    default: [],
    clientEditable: true,
  }),
  "hours.after_hours_mode": setting({
    label: "Outside business hours",
    help: "What the bot does when a customer writes while the business is closed. Emergencies are handled at any hour.",
    field: f.select([
      ["normal", "Reply as usual", "No mention that the office is closed."],
      [
        "set_expectations",
        "Reply, and say when the team is back",
        "The bot qualifies as usual and is clear that people respond when the office opens.",
      ],
      [
        "take_message",
        "Take a message",
        "The bot collects the essentials (job, location, contact) in as few messages as possible.",
      ],
      [
        "auto_reply",
        "Send the after-hours message only",
        "One message per conversation per night.",
      ],
      ["silent", "Stay silent", "The bot answers when the office opens."],
    ]),
    default: "set_expectations",
    clientEditable: true,
  }),
  "hours.after_hours_message": setting({
    label: "After-hours message",
    help: "What customers are told when the office is closed. Sent as written in the auto-reply mode, and used as guidance in the others.",
    field: f.text({
      multiline: true,
      minLength: 1,
      maxLength: 500,
      variables: variables("business_name", "bot_name"),
    }),
    default:
      "Thanks for reaching out to {{business_name}}! The office is closed right now. I can take down the details so the team can pick this up first thing when we open.",
    clientEditable: true,
  }),
  "hours.quiet_hours": setting({
    label: "Quiet hours",
    help: "No follow-up, reminder or other unprompted message is sent to a customer between these times, in the customer's time zone. Messages that fall in the window wait until it ends.",
    field: f.dailyWindow({
      enabled: "Keep quiet hours",
      start: "Quiet from",
      end: "Quiet until",
    }),
    default: { enabled: true, start: "21:00", end: "08:00" },
  }),
  "hours.quiet_hours_cover_replies": setting({
    label: "Hold replies during quiet hours",
    help: "Replies to a message the customer just sent normally go out at any hour. Turn this on to hold those as well until quiet hours end. Emergency replies are never held.",
    field: f.boolean(),
    default: false,
  }),
  "hours.customer_time_zone": setting({
    label: "Customer's time zone",
    help: "How the customer's local time is worked out for quiet hours.",
    field: f.select([
      ["business", "Same as the business"],
      [
        "phone_area_code",
        "From the phone number's area code",
        "Falls back to the business's time zone when the number is unknown or not a US number.",
      ],
    ]),
    default: "business",
  }),
});
