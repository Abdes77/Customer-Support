import { BUSINESS_ONLY, defineCategory, group, setting } from "../define";
import { f } from "../fields";
import { variables } from "../templates";

/**
 * Per-channel options. Consumed by the website widget (C8), WhatsApp (C9), Instagram and
 * Messenger (C10) and email (C11). Whether a channel is connected is a channel connection,
 * not a setting.
 */
export const channelsSettings = defineCategory("channels", {
  ...group("Website chat", {
    "channels.widget.primary_color": setting({
      label: "Color",
      help: "The color of the chat bubble, the header and the visitor's messages.",
      field: f.text({ format: "color", minLength: 7 }),
      default: "#1d4ed8",
      clientEditable: true,
    }),
    "channels.widget.text_color": setting({
      label: "Text color on the color",
      help: "The color of text and icons shown on top of the color above. Pick one that is easy to read.",
      field: f.text({ format: "color", minLength: 7 }),
      default: "#ffffff",
      clientEditable: true,
    }),
    "channels.widget.logo_url": setting({
      label: "Logo",
      help: "Address of a square logo shown in the chat header. Empty shows the bot's initial.",
      field: f.nullable(f.text({ format: "url", minLength: 1, maxLength: 500 }), "No logo"),
      default: null,
      scopes: BUSINESS_ONLY,
      clientEditable: true,
    }),
    "channels.widget.title": setting({
      label: "Header title",
      help: "The title at the top of the chat window.",
      field: f.text({
        minLength: 1,
        maxLength: 60,
        variables: variables("business_name", "bot_name"),
      }),
      default: "{{business_name}}",
      clientEditable: true,
    }),
    "channels.widget.subtitle": setting({
      label: "Header subtitle",
      help: "The line under the title. Leave it empty for none.",
      field: f.text({ maxLength: 80, variables: variables("business_name", "bot_name") }),
      default: "We usually reply in under a minute",
      clientEditable: true,
    }),
    "channels.widget.teaser": setting({
      label: "Teaser next to the bubble",
      help: "A short line shown beside the closed chat bubble to invite a message. Leave it empty for none.",
      field: f.text({ maxLength: 80, variables: variables("business_name", "bot_name") }),
      default: "",
      clientEditable: true,
    }),
    "channels.widget.position": setting({
      label: "Position",
      help: "The corner of the page the chat bubble sits in.",
      field: f.select([
        ["bottom_right", "Bottom right"],
        ["bottom_left", "Bottom left"],
      ]),
      default: "bottom_right",
      clientEditable: true,
    }),
    "channels.widget.auto_open_seconds": setting({
      label: "Open by itself after",
      help: "The chat window opens on its own this long after the page loads, once per visitor. On phones it never opens by itself.",
      field: f.nullable(f.integer({ min: 0, max: 600, unit: "seconds" }), "Never"),
      default: null,
      clientEditable: true,
    }),
    "channels.widget.pre_chat_fields": setting({
      label: "Ask before the chat starts",
      help: "Details a visitor must fill in before the first message. With none, the chat starts at once and the bot asks during the conversation.",
      field: f.multiSelect([
        ["name", "Name"],
        ["phone", "Phone number"],
        ["email", "Email address"],
      ]),
      default: [],
    }),
    "channels.widget.photo_upload": setting({
      label: "Photo upload",
      help: "Visitors can attach photos in the chat.",
      field: f.boolean(),
      default: true,
    }),
    "channels.widget.max_upload_mb": setting({
      label: "Largest photo",
      help: "Photos above this size are refused with a friendly message.",
      field: f.integer({ min: 1, max: 25, unit: "MB" }),
      default: 10,
    }),
    "channels.widget.show_hours_notice": setting({
      label: "Show when the office is closed",
      help: "Outside business hours the chat window says that the office is closed and when it opens.",
      field: f.boolean(),
      default: true,
      clientEditable: true,
    }),
    "channels.widget.consent_text": setting({
      label: "Privacy note",
      help: 'A line shown under the message box, for example "By chatting you agree to our privacy policy." Leave it empty for none.',
      field: f.text({ maxLength: 300 }),
      default: "",
      clientEditable: true,
    }),
    "channels.widget.privacy_url": setting({
      label: "Privacy policy link",
      help: "The privacy note links here when both are set.",
      field: f.nullable(f.text({ format: "url", minLength: 1, maxLength: 500 }), "No link"),
      default: null,
      clientEditable: true,
    }),
    "channels.widget.session_days": setting({
      label: "Remember a visitor for",
      help: "A returning visitor sees their earlier conversation for this long.",
      field: f.integer({ min: 1, max: 365, unit: "days" }),
      default: 30,
    }),
    "channels.widget.allowed_origins": setting({
      label: "Websites that may show the chat",
      help: "The chat only works on these sites. Add every address the site is served from, for example https://www.example.com and https://example.com. With none, the chat works nowhere.",
      field: f.stringList({ itemLabel: "site", format: "origin", maxItems: 30, maxLength: 200 }),
      default: [],
      scopes: BUSINESS_ONLY,
    }),
  }),

  ...group("WhatsApp", {
    "channels.whatsapp.voice_messages": setting({
      label: "Voice messages",
      help: "What happens when a customer sends a voice message.",
      field: f.select([
        ["ask_to_type", "Ask the customer to type", "The bot says it cannot listen to audio yet."],
        ["transcribe", "Transcribe and answer", "Needs a transcription provider to be configured."],
      ]),
      default: "ask_to_type",
    }),
    "channels.whatsapp.buttons": setting({
      label: "Buttons and lists",
      help: "The bot may offer tap-to-answer buttons and lists where they make a question easier, such as picking a time.",
      field: f.boolean(),
      default: true,
    }),
    "channels.whatsapp.follow_up_template": setting({
      label: "Follow-up template",
      help: "Name of the approved message template used for nudges outside the 24-hour window. Empty: no nudge is sent once the window has closed.",
      field: f.nullable(f.text({ minLength: 1, maxLength: 120 }), "No template"),
      default: null,
    }),
    "channels.whatsapp.staff_reply_template": setting({
      label: "Template for the team's late replies",
      help: "Name of the approved message template sent instead when someone at the business replies from the inbox more than 24 hours after the customer's last message. Empty: such replies cannot be sent on WhatsApp.",
      field: f.nullable(f.text({ minLength: 1, maxLength: 120 }), "No template"),
      default: null,
    }),
    "channels.whatsapp.reminder_template": setting({
      label: "Reminder template",
      help: "Name of the approved message template used for meeting reminders outside the 24-hour window. Empty: such reminders are skipped on WhatsApp.",
      field: f.nullable(f.text({ minLength: 1, maxLength: 120 }), "No template"),
      default: null,
    }),
    "channels.whatsapp.template_language": setting({
      label: "Template language",
      help: "The language code the templates above were approved in.",
      field: f.text({ minLength: 2, maxLength: 10, suggestions: ["en_US", "en"] }),
      default: "en_US",
    }),
  }),

  ...group("Instagram and Messenger", {
    "channels.meta.quick_replies": setting({
      label: "Quick replies",
      help: "The bot may offer tap-to-answer quick replies on Instagram and Messenger.",
      field: f.boolean(),
      default: true,
    }),
    "channels.instagram.story_replies": setting({
      label: "Replies to stories",
      help: "What the bot does when someone replies to one of the business's Instagram stories.",
      field: f.select([
        ["reply", "Answer like any message"],
        ["ignore", "Leave them to the team"],
      ]),
      default: "reply",
    }),
    "channels.meta.reactions": setting({
      label: "Reactions",
      help: "What the bot does when a customer reacts to a message with an emoji instead of writing.",
      field: f.select([
        ["ignore", "Nothing"],
        [
          "treat_as_reply",
          "Treat a thumbs-up or a heart as a yes",
          "Only when the bot's last message asked a yes-or-no question.",
        ],
      ]),
      default: "ignore",
    }),
  }),

  ...group("Email", {
    "channels.email.from_name": setting({
      label: "Sender name",
      help: "The name customers see as the sender of the bot's emails.",
      field: f.text({
        minLength: 1,
        maxLength: 80,
        variables: variables("business_name", "bot_name"),
      }),
      default: "{{bot_name}} at {{business_name}}",
      clientEditable: true,
    }),
    "channels.email.signature": setting({
      label: "Signature",
      help: "Added to the end of every email the bot sends.",
      field: f.text({
        multiline: true,
        maxLength: 800,
        variables: variables("business_name", "bot_name", "business_phone", "business_website"),
      }),
      default: "{{bot_name}}\n{{business_name}}\n{{business_phone}}",
      clientEditable: true,
    }),
    "channels.email.greeting": setting({
      label: "Greeting",
      help: "How emails open.",
      field: f.select([
        ["hi_first_name", "Hi Maria,"],
        ["hello_first_name", "Hello Maria,"],
        ["dear_full_name", "Dear Maria Lopez,"],
      ]),
      default: "hi_first_name",
    }),
    "channels.email.sign_off": setting({
      label: "Sign-off",
      help: "The line before the signature.",
      field: f.text({ minLength: 1, maxLength: 40 }),
      default: "Best,",
      clientEditable: true,
    }),
    "channels.email.reply_to": setting({
      label: "Reply to",
      help: "Who gets the bot's reply when the customer's email had other people in copy. Only the sender by default: the others may be other contractors the customer wrote to, or strangers.",
      field: f.select([
        ["all", "Everyone on the email"],
        ["sender", "Only the sender"],
      ]),
      default: "sender",
    }),
    "channels.email.quote_original": setting({
      label: "Quote the customer's email",
      help: "The customer's message is quoted below the reply, as mail programs do.",
      field: f.boolean(),
      default: true,
    }),
    "channels.email.skip_staffed_threads": setting({
      label: "Stay out of threads the team is in",
      help: "The bot does not reply in an email thread where someone at the business has already written from the mailbox (found in its Sent folder). Turn this off only for an inbox that the bot alone answers.",
      field: f.boolean(),
      default: true,
    }),
    "channels.email.internal_domains": setting({
      label: "Internal domains",
      help: "Mail from these domains is treated as internal and never answered. The inbox's own domain is internal too, unless it is a public mail service such as gmail.com.",
      field: f.stringList({ itemLabel: "domain", format: "domain", maxItems: 30 }),
      default: [],
    }),
    "channels.email.ignored_senders": setting({
      label: "Senders to ignore",
      help: "Addresses the bot never answers, such as suppliers or a ticketing system. Newsletters, automatic replies and bounces are ignored without being listed.",
      field: f.stringList({ itemLabel: "address", format: "email", maxItems: 200 }),
      default: [],
      clientEditable: true,
    }),
    "channels.email.max_replies_per_thread_per_day": setting({
      label: "Replies per thread per day",
      help: "The bot sends no more than this many replies in one thread on one day. It stops two auto-responders from answering each other forever.",
      field: f.integer({ min: 1, max: 50, unit: "replies" }),
      default: 8,
    }),
    "channels.email.max_sends_per_hour": setting({
      label: "Emails per hour",
      help: "The most emails the bot sends from one inbox in an hour. Further replies wait.",
      field: f.integer({ min: 1, max: 1000, unit: "emails" }),
      default: 60,
    }),
    "channels.email.max_sends_per_day": setting({
      label: "Emails per day",
      help: "The most emails the bot sends from one inbox in a day. Keep it below the mail provider's own limit.",
      field: f.integer({ min: 1, max: 10_000, unit: "emails" }),
      default: 400,
    }),
  }),
});
