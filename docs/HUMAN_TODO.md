# Human to-do

Everything the autonomous build could not do because it needs a person: an account, a key,
an approval or a production action. The build never deploys, migrates or buys anything.
Each chunk appends entries here; C18 rewrites this file as one ordered launch checklist.

Format of an entry:

> **What** is needed · **Where** to get it · **Variable** to set (names are in `.env.example`,
> values go in `.env.local` locally and in Vercel project settings for production) ·
> **Live check** that was skipped and the command that runs it · **Added by** chunk.

## Open entries

### 1. GitHub: make the `verify` check required (C0)

- **What:** branch protection on `main` that requires the `verify / pnpm verify` check before
  merging. The workflow needs no secrets.
- **Where:** GitHub, repository Settings, Branches (or Rules), add a rule for `main`.
- **Variable:** none.
- **Live check:** open any pull request and confirm the `verify` workflow runs and passes.
  The workflow file was validated for syntax only; it has not run on GitHub yet.

### 2. Claude API key with 30-day data retention (C0, used from C4 on)

- **What:** an API key for the Claude API. The default model `claude-fable-5-2` is refused
  (HTTP 400) for organizations or workspaces without 30-day data retention, so check the
  workspace's retention setting before creating the key.
- **Where:** https://platform.claude.com, Settings, API keys (and Settings, Data retention).
- **Variable:** `ANTHROPIC_API_KEY` (in `.env.local` locally, in the Vercel project for
  production). Leave `AI_MODEL_MODE` unset: with a key the bot uses the Claude API.
- **Live check that was skipped (C4):** the conversation engine has never talked to the
  real model. Everything in `pnpm verify` runs against a mocked model whose answers were
  written by hand. With the key set, run:

  ```
  pnpm --filter @repo/ai live:conversations
  ```

  It plays nine scripted customers (roofing, HVAC, electrical and remodeling leads; a gas
  smell at night; a prompt injection; an angry customer; off-topic questions; spam) against
  the API in dry-run mode: nothing is sent to anyone and nothing is written to a database.
  It prints each transcript, the tool calls and the token counts of every model call, and
  fails when a conversation does not behave as specified or when a model call after the
  first of a conversation reads nothing from the prompt cache. Expect a few cents per
  conversation. Read the transcripts once: they are the first real look at how the bot
  sounds. A single conversation: `pnpm --filter @repo/ai live:conversations emergency`.
  - If every request fails with a 400 that mentions data retention, the workspace does not
    have 30-day retention (see above).
  - If requests fail with a 400 about `strict` or structured outputs, the organization uses
    customer-managed encryption keys: run with `--no-strict` and tell a developer, who sets
    `strictTools: false` where the engine is created (`packages/pipeline/src/composition`).
  - If the first call of a conversation is slow, that is the one-time compilation of the
    tool schemas; later calls reuse it for 24 hours.
  C7 adds `pnpm eval`, the full quality check.

### 3. Supabase project (C1)

- **What:** a Supabase project (PostgreSQL 15 or newer) for production. A second one for
  staging is optional; local development and CI need none.
- **Where:** https://supabase.com/dashboard, New project. Then, in that project:
  1. Project Settings, API: copy the Project URL, the anon (publishable) key and the
     service_role (secret) key. The JWT secret on the same page is needed from C8 on.
  2. Project Settings, Database, Connection string: copy the *Transaction pooler* string
     (port 6543) and the *Direct connection* string (port 5432), both for the role `postgres`.
  3. Authentication, Sign In / Providers: keep Email enabled and switch **off** "Allow new
     users to sign up". Accounts are created by the agency; there is no public sign-up.
  4. Authentication, URL Configuration: set Site URL to the app's public origin and add
     `<APP_URL>/auth/callback` and `<APP_URL>/auth/confirm` to Redirect URLs. The default
     Magic Link email template works as it is.
  5. Storage: create a **private** bucket named `attachments`. Add no policies to it.
- **Variables:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `DATABASE_URL` (transaction pooler),
  `DATABASE_URL_DIRECT` (direct), `SUPABASE_STORAGE_BUCKET` (only if the bucket has another
  name).
- **Commands the build never ran** (it does not touch hosted databases). Run them from a
  machine that has the variables above in `.env.local`:

  ```
  pnpm db:migrate     # creates the schema, the policies and the role app_system
  pnpm db:doctor      # must print "ok" on every line
  ```

- **Live checks that were skipped:**
  - `pnpm db:doctor` against the project. It proves what could only be tested on plain
    PostgreSQL so far: that the `postgres` role may switch to `authenticated` and
    `app_system`, that every table has forced row-level security, and that privileges match
    the policies.
  - Sign in at `<APP_URL>/sign-in` with a password and with an emailed link (after entry 5).
  - File storage: no command yet. The first attachment sent through the test chat (C3) or
    the widget (C8) exercises upload and signed links.
  - Optional, on a staging project only: `SEED_USER_PASSWORD=<12+ characters> pnpm db:seed`
    loads the demo agency and creates its four users through the Supabase Auth admin API.
    The seed refuses to run in production.

### 4. Credential encryption key (C1)

- **What:** the key that encrypts stored channel and integration credentials (OAuth tokens,
  page tokens, IMAP and SMTP passwords, CRM keys). Keep a copy in a password manager: without
  it every stored credential is unreadable and each client has to reconnect.
- **Where:** generate it yourself: `openssl rand -base64 32`.
- **Variable:** `CREDENTIALS_ENCRYPTION_KEY` (and optionally `CREDENTIALS_ENCRYPTION_KEY_ID`,
  default `k1`). To rotate later: put the new key in `CREDENTIALS_ENCRYPTION_KEY` with a new
  id, and move the old one to `CREDENTIALS_ENCRYPTION_OLD_KEYS` as `k1:<old key>`. Old
  credentials keep working and are re-encrypted when they are next written; a command that
  re-encrypts everything at once does not exist yet (C17 or C18).
- **Live check:** the last line of `pnpm db:doctor` ("Credential encryption key").

### 5. First agency and its admin (C1)

- **What:** the agency and the first person who can sign in. Everyone else is invited from
  the admin panel later; nothing can be done before this step.
- **Where:** Supabase dashboard, Authentication, Users, Add user: enter the email address and
  a password and tick "Auto Confirm User". Then, with the production variables in
  `.env.local`:

  ```
  pnpm db:create-admin --agency "Your Agency" --slug your-agency --email you@example.com
  ```

- **Variable:** none.
- **Live check:** sign in at `<APP_URL>/sign-in`.

### 6. Review the defaults that carry legal or safety weight (C2)

- **What:** a person at the agency (and, where it applies, its lawyer) should read these
  defaults before the first real customer is answered. They were written without legal review:
  - `emergency.classes`: the safety instructions the bot gives word for word for gas, carbon
    monoxide, fire, electrical hazards, flooding, no heat, no cooling and structural damage;
  - `persona.ai_disclosure` (default: the bot says it is an AI in its first message) and its
    wording. Some US states require bots to identify themselves;
  - `follow_up.opt_out_keywords`, `follow_up.opt_out_confirmation` and `hours.quiet_hours`
    (default 21:00 to 08:00), which bear on TCPA and carrier rules for text messages;
  - `data.*`: how long conversations, photos and model records are kept.
- **Where:** `docs/SETTINGS.md` lists each default; change them agency-wide on the settings
  screen (C15) at the global scope, or in `packages/settings/src/registry`.
- **Variable:** none.
- **Live check:** none.

### 7. Inngest account, and the test channel secret (C3)

- **What:** an Inngest account (Cloud) for the durable jobs: the reply turn, sending,
  retries and the sweeper. Without it a hosted deployment stores incoming messages but never
  answers (webhooks answer 500 so providers keep retrying). Also a secret for the built-in
  test channel, which the dev chat page and the onboarding wizard's test chat (C15) use.
- **Where:** https://app.inngest.com, create an app (or install the Inngest integration from
  the Vercel Marketplace, which sets the two keys for you). Event key: Manage, Event Keys.
  Signing key: Manage, Signing Key. After the first deploy, sync the app at
  `<APP_URL>/api/inngest` (the Vercel integration does this on every deploy; otherwise
  Apps, Sync new app, or `curl -X PUT <APP_URL>/api/inngest`). The route needs a
  `maxDuration` of 300 s, which needs a Vercel Pro plan.
- **Variables:** `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` (and
  `INNGEST_SIGNING_KEY_FALLBACK` during a key rotation). `TEST_CHANNEL_SECRET`: generate
  with `openssl rand -base64 48`.
- **Live check that was skipped:** the round trip against Inngest Cloud. It ran against the
  Inngest dev server locally (see `autobuild/reports/C3.md`). Against the deployment, from a
  machine with the production `DATABASE_URL` in `.env.local`:

  ```
  APP_URL=<APP_URL> TEST_CHANNEL_SECRET=<the deployment's value> \
    pnpm --filter @repo/pipeline live:roundtrip
  ```

  It posts three quick messages and a duplicate to the test channel's webhook and passes
  when exactly one reply answering all three is sent. Then check the runs in the Inngest
  dashboard (`pipeline-reply`, `pipeline-send`, `pipeline-sweeper` every minute).

### 8. Playbook generation, the website reader and the import API (C6)

- **What:** nothing new to buy. Playbook generation and fact extraction use the Claude API
  key of entry 2. Two things to check in the Claude Console for that key's organization:
  **web search is enabled** (Settings, Capabilities; an administrator can switch it off, and
  then every generation fails with a 400 that says so), and no domain restrictions there
  shut out trade associations or cost guides. Web search is billed per search on top of the
  tokens (the live page said $10 per 1,000 searches on 2026-11-12).
- **Where:** https://platform.claude.com, Settings, Capabilities.
- **Variable:** `ANTHROPIC_API_KEY` (entry 2). No new variable.
- **Live check that was skipped (playbooks):** no playbook has been generated by the real
  model. `pnpm verify` proves the generation against scripted responses for roofing and pest
  control. With the key set, run:

  ```
  pnpm --filter @repo/knowledge live:playbook
  ```

  It researches and writes the playbooks for roofing and pest control exactly as the job
  does, without a database: nothing is stored. For every model call it prints the step, the
  stop reason, the searches, the tokens and the seconds; then the size of each section, the
  price norms and the sources; and it fails when a document is not complete, breaks a rule
  or cites a page the search did not return. Expect several minutes and a few dollars per
  trade. Read both playbooks once (`--out <folder>` writes them as JSON): they are the first
  look at what the research produces. One trade: `live:playbook "Pest control"`; regions for
  the price norms: `--region CO --region MN`.
  - Watch the seconds per call. A call has to finish within 270 seconds, because one job
    step runs inside one request of `/api/inngest` (`maxDuration` 300). If a research step
    is slower, lower "Web searches per research step" (`knowledge.playbook_research_searches`)
    or the effort of "Playbook generation" (`model.playbook.effort`) in the agency's
    settings; the same options exist on the command (`--searches 3`, `--effort medium`).
  - If requests fail with a 400 about `strict`, see entry 2 (`--no-strict` here too).
  - If the first request fails with a 400 that mentions `allowed_callers` or the tool
    version, tell a developer: the tool definition is `webSearchTool()` in
    `packages/knowledge/src/playbooks/generate.ts`.
  Then onboard a real business in a new segment in the admin panel (C15) and watch the run
  finish: the playbook editor shows version 1 with origin "generated".
- **Live check that was skipped (website reader):** the guarded fetcher was run from the
  build VM against one public page; a whole business website and the model's extraction
  were not. Run, for a client's real site:

  ```
  pnpm --filter @repo/knowledge live:crawl https://www.their-website.com --pages 5
  ```

  It prints, per page, the facts that would be stored and what the checks dropped; nothing
  is stored. It must refuse `http://localhost/` and `http://169.254.169.254/` (try them).
  Reading websites is off by default: switch on "Read the business website"
  (`knowledge.website_crawl`) per business or for the agency.
- **Import API:** create a key in the admin panel (C15), or before that screen exists:

  ```
  pnpm --filter @repo/knowledge api-key --slug <agency-slug> --name "Lead-gen sync"
  ```

  The key is printed once. Then send the agency's lead-generation data (replace the key and
  the business's reference; `externalRef` is the business's id in your own data, set in its
  profile or by its first import):

  ```
  curl -X POST https://<app>/api/v1/knowledge/import \
    -H "Authorization: Bearer hsrb_..." -H "Content-Type: application/json" \
    -d '{"businesses":[{"externalRef":"crm-123","facts":[{"category":"services","title":"Services","content":"Roof repair and replacement."}]}]}'
  curl -X POST "https://<app>/api/v1/knowledge/import/csv?external_ref=crm-123" \
    -H "Authorization: Bearer hsrb_..." -H "Content-Type: text/csv" --data-binary @facts.csv
  ```

  Both answered as designed against the app running on the build VM. Give the agency's
  lead-generation tool the first URL; the answer lists every record that was refused and why.

## Local development without any account

Not a to-do, a reminder: `cp .env.example .env.local`, set `LOCAL_AUTH_SECRET` and
`CREDENTIALS_ENCRYPTION_KEY` (`openssl rand -base64 48` and `openssl rand -base64 32`), then
`pnpm services:up && pnpm db:migrate && pnpm db:seed && pnpm dev`. The seed prints the four
demo users; their password is in `packages/db/src/seed/demo.ts`.

Without Inngest variables, jobs run inside the dev server process: sign in as the demo admin
and chat with a business at http://localhost:3000/dev/chat. Without `ANTHROPIC_API_KEY` the
replies come from a built-in rule-based stand-in, not from Claude (the page says so); set the
key to talk to the real bot, or `AI_MODEL_MODE=offline` to force the stand-in. Without the key a
new segment also gets a built-in starter playbook (marked "starter") instead of a researched
one, and the website reader takes facts from structured data only. To use the real Inngest engine
locally instead, start its dev server (`npx inngest-cli@latest dev -u
http://localhost:3000/api/inngest`, or with Docker: `docker run --network host
inngest/inngest inngest dev -u http://127.0.0.1:3000/api/inngest`) and set `INNGEST_DEV=1`
(and `INNGEST_BASE_URL=http://127.0.0.1:8288`) in `.env.local`.

## Accounts the build will ask for

No action yet. Each row becomes a full entry above when its chunk is built; the variables are
already listed and described in `.env.example`.

| Account | Needed for | Variables (group in `.env.example`) | Entry added by |
| --- | --- | --- | --- |
| Meta developer app, business verification, App Review | WhatsApp, Instagram, Messenger | Meta | C9, C10, C18 |
| Google Cloud project (OAuth client, Pub/Sub topic) | Gmail, Google Calendar | Google | C11, C12 |
| Microsoft Entra app registration | Outlook mail and calendar | Microsoft | C11, C12 |
| Twilio account and number | Alert SMS, escalation calls | Twilio | C13 |
| SMTP sender for alerts | Alert email | Alert delivery | C13 |
| Calendly developer app | Calendly scheduling links | Calendly | C12 |
| HubSpot, GoHighLevel, Jobber, Housecall Pro, ServiceTitan developer accounts | CRM connectors | CRM connectors | C14 |
| Sentry project | Error tracking | Observability | C17 |
| Vercel project | Hosting (root directory `apps/web`, Node.js 22, pnpm) | all of the above | C18 |

## Unverified against live services

- **Claude API (C4).** The request the engine sends follows the API reference bundled with
  the build tools (cached 2026-11-03) and the live pages for prompt caching, effort, tool
  use, strict tool use and refusals and fallback on platform.claude.com, read on
  2026-11-11. No request has been sent: there was no key in the build VM. Not yet seen live:
  that `claude-fable-5-2` accepts the request as built (ten strict tools, three cached
  system blocks, a `role: "system"` message after the customer's turn, `fallbacks:
  "default"` with the beta header `server-side-fallback-2026-07-01`); cache reads from the
  second call on; how the model actually writes with this prompt; photo analysis with real
  images; the prices in `packages/ai/src/model/pricing.ts`, which are list prices from the
  cached reference. The live check in entry 2 covers all but the last two; send a photo in
  the test chat (`/dev/chat` cannot upload yet; the widget in C8 can) for the photo path.

- **Claude API web search and playbook generation (C6).** The generation request follows
  the live pages for the web search tool and for server tools (`pause_turn`, mixing server
  and client tools in one turn) on platform.claude.com, read on 2026-11-12, and the API
  reference bundled with the build tools. No request was sent. Not yet seen live: that
  `claude-fable-5-2` accepts `web_search_20260209` with `allowed_callers: ["direct"]` next
  to a strict client tool; how long a research step takes at effort `high`; that the model
  cites only pages from its results on the first attempt; the cache reads between the steps
  (one-hour breakpoints on the step prompts); the quality of the playbooks. The fact
  extraction request (one strict tool, a page as data) is as untested against the live
  model. The live checks of entry 8 cover all of this.

- Nothing in C0 calls a vendor. The Claude API rules in `docs/ARCHITECTURE.md` §5 come from
  the API reference bundled with the build tools (cached 2026-11-03), not from a live request;
  C4 confirms them with the first live call.
- `CHANNEL_CAPABILITIES` in `packages/core/src/contracts/channel.ts` (message length limits,
  messaging windows, button counts) are baseline values from memory. C8–C11 check each number
  against the vendor's current documentation.
- **Supabase (C1).** The schema, the row-level security and both access paths are tested on
  plain PostgreSQL 16 with a compatibility bootstrap that creates Supabase's roles and
  `auth.uid()`. Not yet seen on a real project: the `postgres` role switching to
  `authenticated` and `app_system`, the trigger on `auth.users`, and Supabase's default
  grants being revoked. `pnpm db:doctor` checks all three (entry 3).
- **Supabase Auth (C1).** The provider in `apps/web/src/server/auth/supabase-provider.ts` is
  type-checked against `@supabase/ssr` 0.12 and `auth-js` 2.119 and tested with a stand-in
  client; password and magic-link sign-in have not run against a live project (entry 3).
- **Inngest (C3).** The pipeline's functions ran against the Inngest dev server 1.52.0 (Docker
  image `inngest/inngest`, November 2026) with SDK 4.26.2: debounce, concurrency, steps,
  sleeps and retries behaved as designed. Inngest Cloud (signing keys, the Vercel
  integration, production debounce timing) was not used (entry 7). The Inngest docs site was
  reachable, but the SDK's own type definitions were the reference.
- **Supabase Auth admin API and Storage API (C1).** `packages/db/src/supabase-auth-admin.ts`
  (create a user) and `packages/db/src/storage/supabase-store.ts` (upload, download, delete,
  signed link) are written from the documented REST APIs and tested with a mocked `fetch`.
  The Supabase docs site was not consulted from the build VM.
