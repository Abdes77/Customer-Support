# Build plan: what each chunk owns

The build order and the model for each chunk are in `AUTOBUILD.md` ("Build plan"); the chunks
are built one at a time in that order (note that C6 runs before C5). This file says, for every
chunk, which paths it owns, what it builds on, what it must leave alone and what it hands to
later chunks. Read it together with `docs/ARCHITECTURE.md`.

## Rules that apply to every chunk

1. **Stay in your paths.** Write product code only under the paths your chunk owns. Read
   anything.
2. **Shared files** are touched by many chunks. Touch them only in the way described here:

   | Shared file | How to change it |
   | --- | --- |
   | `pnpm-workspace.yaml` (catalog) | Add a dependency once, with one version, and reference it as `catalog:`. Changing an existing version needs a line in DECISIONS. |
   | `tooling/boundaries.mjs` | Register a new package or a new allowed edge, with a line in DECISIONS. Never add an edge that points up the layers. |
   | `packages/core/src/env/spec.ts` | Declare every new environment variable, then run `pnpm env:example`. |
   | `packages/core/src/contracts/*` | The owner named in the file header finalizes it. Additive changes are free; breaking changes need a DECISIONS line and all consumers fixed in the same chunk. |
   | `packages/core/src/events/*` | Add a file for your events and register them in `EVENT_CATALOG`. Ids and classifications only. |
   | `packages/db` | Add your own schema files and new migrations. Never edit an applied migration. Every new table with business data gets `agency_id`, `business_id`, RLS policies and a place in the isolation tests. |
   | `packages/settings` registry | Declare the settings your feature needs in your category, with defaults, then regenerate `docs/SETTINGS.md`. Do not hard-code a tunable. |
   | `packages/pipeline/src/composition` | Register your `ActionHandler`s and ports. Do not change the turn flow unless you own it. |
   | `apps/web/src/server` | Register your channel adapter and export your Inngest functions to the `/api/inngest` route. |
   | `docs/HUMAN_TODO.md`, `docs/DECISIONS.md` | Append entries. C18 rewrites HUMAN_TODO as the launch checklist. |
   | `CLAUDE.md` | Add a command when you add one. Keep it under 80 lines. |
   | `eslint.config.mjs`, `tsconfig.base.json`, `turbo.json`, `.github/workflows/verify.yml` | Change only with a DECISIONS line. Never loosen a check to make code pass. |

3. **Never edit** `AUTOBUILD.md` or `autobuild/STATE.md`. Never commit, push or switch branch.
4. **`pnpm verify` must stay green and self-contained**: it may rely on local PostgreSQL
   (`pnpm services:up`), never on a vendor account. Live checks are separate commands
   recorded in `docs/HUMAN_TODO.md`.
5. **Logic lives in packages, not in the app.** `apps/web` routes and screens validate,
   authorize and call a package.
6. **Implement against the contracts** in `@repo/core`. If a contract is wrong for your
   chunk, fix the contract (rule 2), do not work around it with a private copy.
7. **From C7 on**, a change to `packages/ai`, prompts, playbooks or default settings must pass
   `pnpm eval` when `ANTHROPIC_API_KEY` is set.

## Chunks

### C0 · Architecture and repo (done by this chunk)

- **Owns:** the root configuration (`package.json`, `pnpm-workspace.yaml`, `turbo.json`,
  `tsconfig.base.json`, `eslint.config.mjs`, Prettier), `tooling/`, `scripts/dev-services.sh`,
  `.github/workflows/verify.yml`, `packages/core` (contracts v0, events, ids, errors, logger,
  env spec), the placeholder packages, the minimal `apps/web`, `docs/ARCHITECTURE.md`,
  `docs/BUILD_PLAN.md`, `CLAUDE.md`.
- **Hands over:** every other package as an empty, lint-clean, typechecked slot.

### C1 · Data model, tenancy and auth

- **Owns:** `packages/db` (Drizzle schema, migrations, RLS policies and helper functions,
  tenant-scoped repositories, AES-256-GCM credential encryption, seed script, test database
  helpers); auth in `apps/web` (`src/proxy.ts` for session refresh, `src/server/auth/**`,
  the sign-in, callback and sign-out routes); the `pnpm db:*` scripts.
- **Builds on:** `@repo/core` ids, roles, errors, env (`DATABASE_URL`, `TEST_DATABASE_URL`,
  `CREDENTIALS_ENCRYPTION_KEY`), `scripts/dev-services.sh`.
- **Must not touch:** setting declarations (C2 owns the registry; C1 only creates the tables),
  any screen beyond sign-in, `packages/ai`, the contracts of other owners.
- **Must deliver for later chunks:**
  - the three access paths from ARCHITECTURE §3 as an API: a user-context client (RLS
    decides), a system-context client reachable only through `forBusiness(businessId)` /
    `forAgency(agencyId)` repositories, and no raw client export;
  - a Supabase-compatibility bootstrap for plain PostgreSQL (roles `anon`, `authenticated`,
    `service_role`, schema `auth`, `auth.uid()`, `auth.jwt()`), applied to local and CI
    databases only, so RLS tests run without the Supabase stack;
  - an isolation test that discovers every table with `business_id` from the catalog, so
    tables added later are covered or the suite fails;
  - the tables listed in ARCHITECTURE §8, including `model_calls`, the conversation turn
    lease, message `sequence`, `enqueued_at` and `trace_id`, dead letters and counters;
  - `encryptSecret` / `decryptSecret` with key ids and tenant-bound additional data;
  - database tests wired into `pnpm verify` that start or reach local PostgreSQL and fail
    loudly when they cannot.

### C2 · Settings engine

- **Owns:** `packages/settings` (registry, resolver, store, generator), `docs/SETTINGS.md`
  (generated), the `pnpm settings:docs` script.
- **Builds on:** C1 tables for setting values and versions, the audit log, `SettingsResolver`
  in `@repo/core`.
- **Must not touch:** `apps/web` screens (C15 renders settings from the registry),
  `packages/ai`, `packages/leads`.
- **Must deliver:** the main entry point free of server imports so the browser can import the
  registry (store and resolver I/O under `@repo/settings/server`); an exported settings type
  (`AppSettings`) used as `ResolvedSettings<AppSettings>`; a way for later chunks to add
  settings by declaring them in one place; a test that `docs/SETTINGS.md` matches the registry.

### C3 · Message pipeline

- **Owns:** `packages/pipeline`, `packages/jobs`, `packages/channels/test`,
  `apps/web/src/app/api/webhooks/[channel]`, `apps/web/src/app/api/inngest`,
  `apps/web/src/app/dev/chat`, `apps/web/src/server` (composition of adapters and functions);
  contract owner of `contracts/channel.ts` and `events/pipeline-events.ts`.
- **Builds on:** C1 repositories, C2 resolver (debounce wait and similar are settings).
- **Must not touch:** `packages/ai` (ship an echo stub that implements `ConversationEngine`
  inside `packages/pipeline`), lead scoring, real channel adapters.
- **Must deliver:** `handleWebhook(channel, request)` and `ingest(parsed)` (ARCHITECTURE §2
  steps 1–7); the reply function with debounce, turn lease, guards and stale check; the send
  function with splitting, ordering, retries and the dead-letter path; the adapter registry;
  the action-handler registry with a default handler that records actions as `deferred`;
  tests for invariants I1–I5 and I7.

### C4 · Conversation engine

- **Owns:** `packages/ai` (model client, versioned system prompt, tools, prompt assembly and
  caching, tool loop, output guard, model-call logging, dry-run entry point, scripted
  conversation tests); contract owner of `contracts/engine.ts`.
- **Builds on:** C2 settings, C3 pipeline and ports, the Claude API rules in ARCHITECTURE §5.
- **Must not touch:** scoring and routing rules (C5), playbook generation and knowledge import
  (C6), the pipeline's turn flow (replace only the stub at the composition root).
- **Must deliver:** `createEngine(...)` implementing `ConversationEngine`; a mock or replay
  model client usable by every other package's tests; the model client as a reusable export
  for C5, C6, C7 and C13; a placeholder `KnowledgeRetriever` and playbook until C6 lands.

### C6 · Industry playbooks and business knowledge (built before C5)

- **Owns:** `packages/knowledge`, the import API under `apps/web/src/app/api/v1`; contract
  owner of `contracts/knowledge.ts`.
- **Builds on:** C1 tables, C4 model client (web search for playbook generation), the SSRF-safe
  fetch rule in ARCHITECTURE §3.
- **Must not touch:** admin screens (C15 builds the editors on top of this package's server
  functions), the engine's prompt beyond wiring the retriever and playbook in.
- **Must deliver:** the real `KnowledgeRetriever` registered in the pipeline composition;
  playbook generate, reuse, version, diff, roll back and per-business override functions;
  CSV and API import with mapping and validation; the crawler behind the safe fetcher.
- **Delivered, for C15, C16 and C7:** `getKnowledge()` in `apps/web/src/server/knowledge`
  gives `playbooks` (segments, versions, `diffVersions`, `saveEdit`, `rollback`, `regenerate`,
  overrides, `assignSegment` for the onboarding wizard), `knowledge` (facts, `importCsv`,
  `crawlWebsite`, import runs) and `apiKeys`; `previewCsv` and `suggestMapping` draw the
  import's mapping screen; `@repo/knowledge/testing` has complete playbooks and the scripted
  model responses that generate them. ARCHITECTURE §2 "As built (C6)" has the rest.

### C5 · Lead scoring, reports and routing

- **Owns:** `packages/leads`; contract owner of `contracts/lead.ts` and
  `events/lead-events.ts`.
- **Builds on:** C2 qualification and routing settings, C4 actions, C1 lead tables.
- **Must not touch:** the engine's prompt (the decision reaches the model as the tool result
  and as `lead.routing` in the next turn's input), alert delivery (C13), CRM pushes (C14).
- **Must deliver:** the `update_lead_fields` and `mark_not_a_fit` handlers registered in the
  pipeline; deterministic scoring and routing; the written report; emission of the five
  `lead.*` events with idempotent `eventId`s.

### C7 · Evaluation harness

- **Owns:** `packages/evals`, the `pnpm eval` command, the eval CI workflow, the saved
  baseline and the HTML report.
- **Builds on:** the pipeline's domain composition in dry-run mode (invariant I8).
- **May change:** `packages/ai` prompts and engine to make the suite pass, keeping
  `pnpm verify` green.
- **Must not touch:** production wiring, settings defaults without recording the reason in
  DECISIONS.
- **Delivered, for every later chunk:** `pnpm eval` (ARCHITECTURE §2 "As built (C7)").
  Without a key it is a mock run against stand-ins, which still fails when a rule the
  engine enforces in code breaks: keep `pnpm eval --mode mock` green. A chunk that
  registers an action handler (C12, C13) looks at `sandboxTools` in
  `packages/evals/src/simulate/conversation.ts`; a chunk that adds a setting the bot must
  obey adds it to the judge's rules (`packages/evals/src/grade/rules.ts`) and, where code
  can check it, to `packages/evals/src/grade/checks.ts`. No live baseline exists yet
  (HUMAN_TODO 10).

### C8 · Website chat widget

- **Owns:** `packages/channels/widget` (adapter, visitor sessions, allowed origins, rate
  limits), `packages/widget-embed` (the browser script and its build),
  `apps/web/src/app/api/widget/**`, the Playwright setup (`apps/web/e2e`,
  `playwright.config.ts`, `pnpm e2e`).
- **Builds on:** `ingest()` from C3, widget appearance settings from C2, Storage from C1.
- **Must not touch:** the admin screen that shows the embed code (C16; expose the data).
- **Must deliver:** the embed script small enough not to slow the host page, with its size
  checked in a test.
- **Delivered, for C16 and C17:** `@repo/channel-widget/server` has `widgetEmbedInfo` (the
  snippet, key, status and allowed sites for the connection page), `ensureWidgetConnection`,
  `rotateWidgetKey` and `setWidgetEnabled` (call them in the business's system scope after
  checking the user); the allowed sites are the setting `channels.widget.allowed_origins`.
  `pnpm e2e` runs Playwright against a fresh database (`apps/web/e2e/support/app-server.ts`):
  add specs next to `widget.spec.ts`. ARCHITECTURE §2 "As built (C8)" has the rest.

### C9 · WhatsApp

- **Owns:** `packages/channels/meta` (Graph client, webhook verification, rate limits; shared
  with C10), `packages/channels/whatsapp`, the Meta OAuth and Embedded Signup routes.
- **Must not touch:** connection screens (C16; expose server functions), the pipeline's
  window logic beyond supplying capabilities, window state and templates.
- **Must deliver:** adapter registered in `apps/web/src/server`; fixtures for every inbound
  type; tests for invariant I6; the choice of audio transcription provider recorded in
  DECISIONS and HUMAN_TODO.
- **Delivered, for C10, C13, C16 and C17:** `@repo/channel-meta` (signature, Graph client,
  error classes, media, code exchange); the `provider_event` signal and the pipeline's
  `windowFallbacks`, `providerEvents` and `attachmentEnrichers`; WhatsApp's template fallback
  outside the 24-hour window (C13's follow-ups need no channel code); `getWhatsApp()` in
  `apps/web/src/server/whatsapp` (connections, Embedded Signup, templates) and
  `POST /api/oauth/meta/whatsapp` for C16's connection page; `message_parts` and
  `pending_delivery_statuses` for delivery tracking. Fixtures and a fake Graph API:
  `@repo/channel-whatsapp/testing`. ARCHITECTURE §2 "As built (C9)" has the rest.

### C10 · Instagram and Messenger

- **Owns:** `packages/channels/messenger-instagram`.
- **Builds on:** `packages/channels/meta` from C9. Extend it there; do not fork it.
- **Must not touch:** `packages/channels/whatsapp`, the takeover rules themselves (C13 owns
  them; C10 only emits the signal), connection screens (C16).
- **Must deliver:** `human_agent_replied` signals that trigger takeover through the pipeline;
  human-agent tagging driven by `SendTarget.sentByHuman`.
- **Delivered, for C13, C16 and C17:** `@repo/channel-messenger-instagram` (two adapters over
  the Page's Send API, fixtures and a fake Graph API under `/testing`); hand-over on a reply
  from Meta's inbox (`human_agent_replied` with `attribution`, matched against our own sends
  by the pipeline); the HUMAN_AGENT tag from `SendTarget.standardWindowOpen`; the
  `delivery_watermark` signal; `PipelineDeps.channelGuards` with `metaChannelGuard`;
  `getMetaPages()` in `apps/web/src/server/meta-pages` and `POST /api/oauth/meta/facebook`
  for C16's connection page. ARCHITECTURE §2 "As built (C10)" has the rest.

### C11 · Email

- **Owns:** `packages/channels/email` (Gmail, Microsoft Graph, IMAP/SMTP, threading, body
  cleaning, classification of automatic mail, sending limits), the Gmail and Graph
  notification routes, the email crons.
- **Builds on:** `ingest()` from C3 (email does not use `parseWebhook`).
- **Must not touch:** the engine's email formatting rules (the engine writes the body; this
  package wraps it in headers, signature and HTML), calendar code (C12 owns Google and
  Microsoft calendar access even though the OAuth apps are shared), connection screens (C16).
- **Must deliver:** a local mail server recipe for the IMAP/SMTP round-trip test that runs
  inside `pnpm verify` or a documented separate command.
- **Delivered, for C12, C13, C16 and C17:** `@repo/channel-email` (adapter, MIME parsing and
  building, body cleaning, classification of automatic mail, threading, composition, Gmail,
  Graph and IMAP/SMTP clients, the SSRF rules for mail servers), `/server` (connection
  service, notification handlers, `email-sync`, `email-poll`, `email-watch-renew`, the
  composer, the send throttle and `emailChannelGuard`) and `/testing` (raw fixtures, fake
  Gmail and Graph, `startLocalMailServer`: ImapKit with TLS, used by the round trip inside
  `pnpm verify`, e.g. `pnpm --filter @repo/web test -- src/server/email`). The pipeline gained
  `outboundComposers` and `sendThrottles` (`PipelineDeps`) and `human_agent_replied.externalThreadId`.
  `getEmail()` in `apps/web/src/server/email` and the routes `POST /api/oauth/email/{google|microsoft}`
  (+ callback) and `POST /api/channels/email/imap` are for C16's connection page.
  ARCHITECTURE §2 "As built (C11)" has the rest.

### C12 · Scheduling

- **Owns:** `packages/scheduling`, the Calendly webhook route, calendar OAuth callbacks.
- **Builds on:** scheduling settings from C2, the `offer_times` and `book_meeting` actions
  from C4, lead reports from C5.
- **Must not touch:** `packages/channels/email` (reuse its OAuth app configuration through
  env, not its code), the engine's prompt, integration pages (C16).
- **Must deliver:** the `offer_times` and `book_meeting` handlers registered in the pipeline;
  subscribers to `lead.meeting_requested`; reminders as jobs.
- **Delivered, for C13, C14, C16 and C17:** `@repo/scheduling` (availability, Google and
  Outlook clients, Calendly, the booking service, `schedulingActionHandlers` for
  `offer_times`, `book_meeting` and the new `cancel_meeting`, `createSchedulingJobs`,
  `createSchedulingConnectionService`, `createCalendlyWebhookHandler`; `/testing` with fakes
  of the vendors); `enqueueBotMessage` in `@repo/pipeline` for code-written messages;
  `getScheduling()` in `apps/web/src/server/scheduling` and the routes
  `POST /api/oauth/calendar/{google|microsoft|calendly}` (+ callback),
  `POST /api/integrations/calendly/token`, `POST /api/webhooks/calendly/{key}` for C16's
  integration page; the event `scheduling.booking_changed`. ARCHITECTURE §2 "As built
  (C12)" has the rest.

### C13 · Handoff, alerts, emergencies and follow-ups

- **Owns:** `packages/handoff`, Twilio webhook routes.
- **Builds on:** alert, emergency, takeover and follow-up settings from C2, the reply
  function's takeover guard from C3, `lead.*` events from C5.
- **Must not touch:** the pipeline's turn flow and send function (follow-ups and manual
  replies go through them), scoring (C5), the inbox screens (C16).
- **Must deliver:** the `schedule_follow_up`, `escalate_emergency` and `handoff_to_human`
  handlers; subscribers to `lead.*` for alerts; the takeover lock API used by C16; follow-up
  turns triggered through the pipeline (`trigger: "follow_up"`), never by calling a channel
  adapter directly.
- **Delivered, for C14, C15, C16 and C17:** `@repo/handoff` (alerts, the emergency chain and
  its acknowledgements, takeover, opt-out, follow-ups, the quiet-hours gate; `/testing` with
  fakes of Twilio and the WhatsApp Cloud API); the pipeline's `conversation.turn_requested`
  and `pipeline-requested-turn`, `inboundObservers`, `sendGates`, `enqueueHumanMessage` and
  `takeover_locks.exempt_through_seq`; `getHandoff()` in `apps/web/src/server/handoff` for
  C16's inbox (takeover, release, manual reply, typing activity, opt-out, escalations,
  follow-ups, test alert) and C15's alert contacts step (emergency readiness);
  the routes `/api/handoff/twilio/{sms|voice|status}` and `/api/handoff/ack/{token}`.
  ARCHITECTURE §2 "As built (C13)" has the rest.

### C14 · CRM and webhook connectors

- **Owns:** `packages/integrations`, `docs/INTEGRATIONS.md`, CRM OAuth callback routes;
  contract owner of `contracts/integration.ts`.
- **Builds on:** `lead.*` events and the lead report from C5, field-mapping settings from C2,
  credential encryption from C1.
- **Must not touch:** `packages/leads` (subscribe to its events; do not call connectors from
  scoring code), calendars and Calendly (C12), integration screens (C16).
- **Must deliver:** connectors behind `IntegrationConnector`, each with contract tests on
  recorded fixtures; subscribers to `lead.*`; errors readable in the admin panel.

### C15 · Admin core

- **Owns:** `apps/web/src/app` admin route groups for sign-in shell, navigation, business
  list, onboarding wizard, knowledge editor, playbook viewer and editor, settings screen;
  `apps/web/src/components/**`; Tailwind and shadcn/ui setup.
- **Must not touch:** package logic. If a screen needs a query or mutation that does not
  exist, add it to the owning package.
- **Must deliver:** the settings screen rendered only from the registry; empty slots (routes
  and navigation entries) for the channel and integration pages of C16.

### C16 · Inbox, leads and analytics

- **Owns:** the inbox, conversation view, lead list, channel and integration connection
  pages, analytics, client portal and audit log viewer in `apps/web`.
- **Builds on:** the server functions exposed by C8–C14 and Realtime from C1.
- **Must not touch:** package logic (add a missing query or mutation to the owning package),
  the screens built by C15 except to fill the slots it left, RLS policies (a client user who
  sees too much is a `packages/db` bug to fix there, with a test).

### C17 · Security and reliability

- **Owns:** `packages/observability`, `docs/THREAT_MODEL.md`, health and readiness routes,
  retention jobs.
- **May change:** any package to fix a finding, with a test that proves the fix, keeping the
  contracts intact.
- **Must not touch:** product behaviour that is not a finding (no refactors for taste), the
  eval baseline without re-running `pnpm eval`, production systems.
- **Open from the C8 review (website chat, `/api/widget/v1`):**
  - Client address: `clientIp` in `apps/web/src/server/widget/http.ts` takes the last
    `x-forwarded-for` hop, which is right on Vercel alone. With a CDN or another proxy in front,
    that hop is the proxy: decide which header the deployment trusts. The address feeds only
    `limits.widget_sessions_per_ip_per_hour`.
  - Edge limits: `GET config` and `POST session` are not counted per address before the
    database is reached (only new sessions are), and polls are counted per session (120 a
    minute, `READS_PER_SESSION_PER_MINUTE`), so a client that starts many sessions can still
    make many cheap reads. Consider a platform rate limit (Vercel firewall) on `/api/widget/v1`.
  - Growth: `widget_sessions` rows (one per new visitor, kept until expiry), `usage_counters`
    windows (one row per session per minute polled) and photos stored under
    `{agency}/{business}/uploads/` whose message was never ingested (ingest failed, or a
    retried duplicate) are not cleaned up yet: the retention jobs should cover them.
- **Open from the C11 review (email, `packages/channels/email`):**
  - Hand-over now rests only on mail read from the mailbox's Sent folder through the
    authenticated API or IMAP session (DECISIONS 193). A colleague who answers a customer
    from another mailbox with the shared inbox in copy reaches us only through the INBOX,
    where From is unauthenticated, so it no longer hands over. If that case matters, accept it
    only with an authenticated origin: the receiving provider's own `Authentication-Results`
    (the topmost one, added by Gmail or Exchange Online for this mailbox) showing
    `dmarc=pass` for the business's domain, or the colleague's own mailbox connected too.
  - Own-send recognition without headers (DECISIONS 194) falls back to matching the words of
    our reply on Graph. Once HUMAN_TODO 14's live check shows whether Gmail and Exchange keep
    `Message-ID` and `X-HSRB-Loop`, decide whether Graph should send through a draft
    (`POST /me/messages` with MIME, then `/send`) to get an id, and whether
    `email.own_send_without_marker` should alert.
  - Reflection: anyone can write "from" (or with Reply-To) an address of their choosing and
    the bot answers that address, quoting their text, from the business's inbox. Bounded by
    the per-thread, per-contact and per-inbox limits; consider a per-recipient-domain limit
    and not quoting the customer's message to an address that never wrote before.
  - A forged delivery report naming one of our Message-IDs (known to its recipients) can
    mark that reply `failed`. Only a status; consider requiring the report to come through
    the provider's own bounce path (Gmail and Exchange deliver DSNs from their own daemons).

### C18 · End-to-end tests and launch preparation

- **Owns:** `apps/web/e2e` journeys, the load test, `docs/RUNBOOK.md`, `docs/ONBOARDING.md`,
  the Meta App Review pack, the final `docs/HUMAN_TODO.md` and `docs/BUILD_REPORT.md`.
- **Must not:** deploy, migrate production or change behaviour beyond fixing failures the
  tests expose.

## Who registers what in the pipeline

| `EngineAction` | Handler owner | Until then |
| --- | --- | --- |
| `update_lead_fields`, `mark_not_a_fit` | C5 `packages/leads` | recorded as `deferred` |
| `request_photo`, `analyze_photos`, `end_conversation` | C4 `packages/ai` with the pipeline | — |
| `offer_times`, `book_meeting`, `cancel_meeting` | C12 `packages/scheduling` (registered) | `rejected`, so the bot says the team will be in touch |
| `schedule_follow_up`, `escalate_emergency`, `handoff_to_human` | C13 `packages/handoff` (registered) | recorded as `deferred` |
