# Spec: home-services reply bot

A multi-tenant system that replies to inbound customer messages for US local home-services
businesses (kitchen and bath remodeling, roofing, electricians, HVAC, plumbing and any other
segment). It qualifies each customer, keeps the conversation engaging so they don't drop off,
and hands off according to each business's settings. An agency operates it for many client
businesses through an admin panel.

- Tenancy: the agency, then client businesses, then their customers. Agency staff use the admin
  panel. Client owners and staff can optionally get limited logins (a per-business setting).
- Channels: WhatsApp (Cloud API), Instagram DMs, Facebook Messenger, an embeddable website chat
  widget, and email (Gmail API, Microsoft Graph, any IMAP/SMTP inbox on the client's domain).
  English only.
- Replies: written by the Claude API, model claude-fable-5-2 by default. Model and effort are
  settings. Quality comes before cost. Replies reflect the business's industry, its own
  information, and the best way to qualify the lead while keeping the conversation interesting.
- Business knowledge: imported from the agency's lead-generation data (CSV upload or API) and
  editable in the admin panel.
- Industry playbooks: one per segment (common jobs, how customers describe problems, urgency
  signals, qualification questions, objections, pricing norms, vocabulary). Generated the first
  time a business is onboarded in a new segment, reused and versioned for later clients in that
  segment, editable in the admin panel, overridable per business.
- Lead scoring: every lead always gets a score and a written report. Settings decide who is
  booked straight into a meeting and who is told "we'll contact you"; one option tells everyone
  "we'll contact you".
- Settings: everything is a setting, with global defaults and per-business overrides, and as many
  relevant options as possible: qualification criteria, weights and thresholds; routing; pricing
  disclosure; photo requests and analysis; bot name, persona and AI disclosure; tone and length;
  emergency rules and escalation; follow-up cadence; business hours, after-hours and quiet hours;
  service area; handoff actions and integrations; model and effort.
- Integrations: Google Calendar, Outlook Calendar, Calendly; alerts by email, SMS (Twilio) and
  WhatsApp; HubSpot, GoHighLevel, Jobber, Housecall Pro, ServiceTitan; a generic outgoing webhook.
- Admin panel: onboard businesses, connect channels, import data, edit knowledge, playbooks and
  settings, a live inbox with human takeover, a lead list with scores and reports, analytics.
- Quality: an evaluation harness with simulated customers that every prompt or engine change
  must pass.

Stack (decided): TypeScript monorepo with pnpm and Turborepo; Next.js App Router on Vercel for
the admin panel, APIs, webhooks and widget; Supabase (Postgres, Auth, Storage, Realtime) with
Drizzle ORM and migrations; Inngest for durable jobs, delays, debounce and cron; the Anthropic
TypeScript SDK; Zod; Vitest and Playwright; Tailwind and shadcn/ui.
