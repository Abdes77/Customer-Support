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
- **Variable:** `ANTHROPIC_API_KEY`.
- **Live check:** none exists yet. C4 adds the command that runs a live conversation and
  shows prompt-cache reads; C7 adds `pnpm eval`.

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

## Local development without any account

Not a to-do, a reminder: `cp .env.example .env.local`, set `LOCAL_AUTH_SECRET` and
`CREDENTIALS_ENCRYPTION_KEY` (`openssl rand -base64 48` and `openssl rand -base64 32`), then
`pnpm services:up && pnpm db:migrate && pnpm db:seed && pnpm dev`. The seed prints the four
demo users; their password is in `packages/db/src/seed/demo.ts`.

## Accounts the build will ask for

No action yet. Each row becomes a full entry above when its chunk is built; the variables are
already listed and described in `.env.example`.

| Account | Needed for | Variables (group in `.env.example`) | Entry added by |
| --- | --- | --- | --- |
| Inngest account | Durable jobs | Inngest | C3 |
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
- **Supabase Auth admin API and Storage API (C1).** `packages/db/src/supabase-auth-admin.ts`
  (create a user) and `packages/db/src/storage/supabase-store.ts` (upload, download, delete,
  signed link) are written from the documented REST APIs and tested with a mocked `fetch`.
  The Supabase docs site was not consulted from the build VM.
