# Onboarding a client business

For agency staff. How to bring a new client business onto the reply bot, from the first
conversation with the client to the day its customers start writing, and how to work with it
afterwards. You need an agency login (an agency admin or member). Nothing here needs a
developer, except where it says so.

Before the very first business, the launch checklist (`docs/HUMAN_TODO.md`) must be done, and
the bot has to have been tried with the real Claude API (steps 24 and 25). Until then the bot's
replies on a developer's computer come from a simple rule-based stand-in, not from the real
model: do not judge the bot's quality by them.

## 1. Before you start: what to ask the client

Collect these from the client. The wizard asks for most of them; the rest go on the Settings
tab.

- **The business:** name, website, main phone, time zone, the services they offer and the ones
  they do not, licenses, warranties, financing, brands, what makes them different, reviews they
  are proud of.
- **Where they work:** the ZIP codes (preferred), towns or states they serve. A radius in miles
  cannot be checked by the product; list ZIP codes instead.
- **When they work:** opening hours per day, holidays, and what the bot should do outside them
  (answer normally, set expectations, take a message, send a fixed reply, or stay silent).
- **Prices:** whether the bot may talk about prices at all, as ranges, or exactly; service-call
  and estimate fees; current promotions.
- **Leads:** what makes a lead good for them (job types, budget, timeline, homeowner or not),
  and what should happen to good, average and poor leads: book a meeting straight away, "we'll
  contact you", or a polite no.
- **People:** who gets lead alerts and how (text, email, WhatsApp), and the **emergency
  contacts** in order, with a mobile number each: they are texted and then called when a
  customer reports a gas smell, a fire, sparking, flooding or no heat in freezing weather.
- **Accounts to connect:** their WhatsApp Business number, Facebook Page and Instagram account,
  the inbox customers write to, their calendar (Google, Outlook or Calendly), their CRM
  (HubSpot, GoHighLevel, Jobber, Housecall Pro, ServiceTitan) or a Zapier/Make webhook. For
  each, the person at the client who can sign in to it must be available when you connect it.
- **Their customer data** from the agency's lead-generation work: a CSV file, or the agency's
  tool sending it through the import API.

## 2. The onboarding wizard

Businesses, **Onboard a business**. The wizard saves each step; you can leave and come back.

1. **Profile.** Name, website, phone, time zone, address. These appear in the bot's replies
   and in alerts.
2. **Segment.** The trade (roofing, HVAC, plumbing, electrical, remodeling, pest control, or a
   new one). If the agency already serves the trade, the business reuses its playbook. A new
   trade starts a research run that writes a playbook with the Claude API and web search; it
   takes several minutes.
3. **Business data.** Upload the client's CSV (map its columns to the fields the page shows,
   check the preview, import), and optionally let the bot read the client's website (it is off
   by default: "Read the business website", setting `knowledge.website_crawl`). Every fact
   becomes an editable knowledge item with its source. Check the result on the business's
   Knowledge tab: services, service area, hours, licenses, warranties, financing. The bot only
   states what is here and in the settings; anything missing, it does not promise.
4. **Playbook.** Review the trade's playbook: common jobs, how customers describe problems,
   urgency signals, the qualification questions, objections, seasonal patterns, price norms,
   permits and vocabulary. A version marked "starter" was **not** written by the real model (no
   API key was configured). You can edit a section for this business only (an override) without
   changing the trade's playbook.
5. **Alert contacts.** Add the people who get lead alerts and the emergency escalation chain.
   **Do not finish without at least one emergency contact**: with an empty chain an emergency
   alerts nobody by phone (the wizard asks you to acknowledge that explicitly).
6. **Test chat.** Write as a customer would, on the built-in test channel: a normal request, a
   price question, an emergency ("I smell gas"), something off-topic. Read the replies and the
   lead panel. Adjust knowledge and settings until the answers are right.
7. **Finish.** Activates the business.

## 3. Settings to review for every business

The business's **Settings** tab shows every setting grouped by category, the value in force,
where it comes from (default, agency, segment, or set here) and the inherited value; "Override"
changes it for this business only, "Reset" returns to the inherited value. Review at least:

- **Persona and AI disclosure:** the bot's name (`persona.bot_name`), its role, and how it says
  it is an AI (`persona.ai_disclosure`). The agency's compliance decision applies here
  (HUMAN_TODO step 37).
- **Pricing disclosure** (`pricing.disclosure`): never, ranges, or exact; fees and promotions.
- **Lead qualification, scoring and routing:** the criteria and their weights, the hot and warm
  thresholds, and what each band leads to (`routing.hot_outcome`, `routing.warm_outcome`,
  `routing.cold_outcome`). Booking straight into a meeting needs a connected calendar.
- **Hours:** opening hours, holidays, after-hours mode, quiet hours (no follow-ups at night).
- **Emergencies:** which classes apply to this trade, and the escalation timing.
- **Follow-ups:** how often and how many times the bot nudges a customer who went quiet, per
  channel.
- **Handoff:** when a person takes over and when the bot takes the conversation back.
- **Client portal:** whether the client gets logins (`client_portal.enabled`) and what owners
  and staff may see and do (conversations, leads, reports, export, analytics, replying), and
  whether the owner may manage their own staff's logins (`client_portal.owner_manages_staff`,
  off by default). The logins themselves are added on the business's People tab (section 9).

## 4. Connecting the channels

The business's **Channels** page. Connect one channel at a time and test each one by writing to
it from your own phone or email before the client's customers do.

- **Website chat.** Put every address the client's site is served from on the allowed list
  (`channels.widget.allowed_origins`, for example `https://www.example.com` and
  `https://example.com`), set its look (colour, logo, title, greeting, position) on the Settings
  tab, then copy the snippet from the Channels page and send it to whoever edits the client's
  site: one script tag, before `</body>`. With an empty allowed list the chat shows nowhere.
- **WhatsApp.** "Connect with Facebook", with the client's Meta admin at your side: they choose
  or create their WhatsApp Business account and number (Embedded Signup). Then create the
  suggested message templates on the same page and wait for Meta's approval (minutes), and set
  the follow-up and staff-reply templates in Settings (`channels.whatsapp.follow_up_template`,
  `channels.whatsapp.staff_reply_template`): outside 24 hours after the customer's last message
  WhatsApp only delivers approved templates.
- **Messenger and Instagram.** "Connect with Facebook" (Facebook Login), choose the client's
  Page (its Instagram professional account comes with it). In the client's Meta Business Suite,
  leave the app as the Page's messaging app and turn off any other automated replies; on
  Instagram, "Allow access to messages" must be on.
- **Email.** "Connect Gmail" or "Connect Microsoft 365" with the inbox owner signing in, or the
  IMAP/SMTP form (server names, ports, login and an app password where the provider requires
  one) for any other mail provider. The bot answers in the same thread, with the business's
  signature, and ignores newsletters, out-of-office replies and bounces. When someone at the
  business answers a customer from the mailbox itself, the bot stops in that thread.

Each channel shows "connected", "needs reconnecting" or an error with the provider's reason.
`docs/RUNBOOK.md` says how to reconnect.

## 5. Calendars, CRMs and alerts

The business's **Integrations** page.

- **Calendar:** connect Google Calendar or Outlook (the client signs in) or Calendly (OAuth, or
  a personal access token from the client's Calendly account and the event type's page). Set
  the meeting length, buffers, lead time and how many times the bot offers on the Settings tab
  (Scheduling). The bot offers two or three real free times, books the one the customer picks
  with the lead report in the event, and moves or cancels it when the customer asks.
- **CRM:** connect it (OAuth or the client's API key), check the field mapping, and choose which
  events are sent (`integrations.sync_events`). For Zapier, Make or the client's own system, add
  a webhook target; its signing secret is shown to agency admins on request.
  `docs/INTEGRATIONS.md` has the details per CRM, including what each vendor requires.
- **Alerts:** who gets which alert on which channel (`alerts.recipients`), and whether alerts
  for leads at night wait for the morning (`alerts.hold_overnight`). Emergencies always go out.

## 6. Go-live check for each business

- [ ] The test chat answers a normal request, a price question and an emergency as the client
      wants.
- [ ] Knowledge and the playbook say nothing the client does not stand behind.
- [ ] At least one emergency contact with a mobile number; an emergency in the test chat texted
      them.
- [ ] Each connected channel answered a message from your own phone or address.
- [ ] A qualified test lead reached the calendar, the CRM and the alert recipients as expected.
- [ ] The client has seen a few test conversations and agreed to the persona, the AI disclosure
      and the pricing policy.

## 7. Day to day

- **Inbox:** every conversation across businesses and channels, with filters, search, unread
  state and assignment. Open one to see the conversation, the lead panel (each criterion with
  its evidence, the score, the report and the routing decision) and any emergency or follow-up.
- **Taking over:** "Take over" pauses the bot for that conversation; your reply goes out on the
  customer's own channel (on WhatsApp, Messenger and Instagram the channel's rules for late
  replies apply). "Release to the bot" gives it back; the bot also takes it back after the idle
  time in the handoff settings. Internal notes are visible to agency staff only.
- **Leads:** the list with scores, status and filters, and a CSV download.
- **Analytics:** conversations, first-response time, qualification rate, meetings booked and
  where conversations drop off, by business, channel and segment.
- **Changing what the bot says:** knowledge items and the playbook (for every business of the
  trade, or an override for one), and the settings. Every change is recorded in the audit log.

## 8. When something looks wrong

- The bot said something wrong: correct the knowledge item or setting behind it, take the
  conversation over if the customer is still there, and tell the developer when the bot
  invented something that is nowhere in knowledge or settings.
- A channel stopped: its page says why; reconnect it (`docs/RUNBOOK.md`).
- A customer is angry or the situation is delicate: take over.
- A customer asks to stop messages: the bot records the opt-out word and confirms once;
  follow-ups stop for good. What the bot does with their later messages depends on the agency's
  opt-out setting (HUMAN_TODO step 37).

## 9. People and logins

Who may use the admin panel, and how to give or take away access. Every addition, role change
and removal is in the audit log with the name of the person who made it.

**The agency's team** (**People** in the menu): agency admins and agency members. A member works
on every business; an admin also manages people, API keys and agency-wide settings and reads
the audit log. Agency admins add someone by email with a role, change a role and remove access;
members see the list only.

**A business's client logins** (the business's **People** tab): its owner and staff, who see
this business only and only what its client-portal settings allow. Agency admins add, change
and remove them. When `client_portal.owner_manages_staff` is on, the business's owner can add
and remove their own staff (never another owner, never a role change). Agency members see the
list only. Logins work only while `client_portal.enabled` is on; the tab warns when it is off.

How it works:

- **Adding:** type the email and pick the role, then "Add and invite". The person gets an email
  with a link that signs them in: an invitation if they are new, a sign-in link if they
  already have an account (for example with another agency). The screen answers the same in
  both cases. Each person can add at most 20 people a day.
- **Changing a role:** pick the new role in the person's row.
- **Removing:** "Remove", then "Confirm removal". Their access ends with their next click, not
  at the end of their session.
- **Your own access:** nobody can change or remove their own. Keep a second agency admin so
  that one can always fix the other's; an agency always keeps at least one agency admin (the
  last one cannot be removed or made a member).
- **Before giving a client logins**, read `docs/HUMAN_TODO.md` step 5.6: until the Supabase Data
  API is closed, a client login can read more than the portal shows.

