# Launch checklist

This is the list of everything a person has to do before the reply bot answers real customers:
the accounts to create, the keys to copy and where to paste them, the commands that put the
system online, the checks that prove each outside service works, and the decisions to make
with a compliance adviser. Do the steps in order. Each step says what to do, where, and how
you know it worked.

**Read this first.** The system was built and tested on one computer without any outside
account. Nothing in it has ever talked to the real Claude API, Meta (WhatsApp, Messenger,
Instagram), Google, Microsoft, Twilio, Calendly, a CRM, Supabase, Inngest Cloud or Sentry, and
it has never run on a hosted server. Part 5 below is where each of those is tried for the first
time. Expect some of those first tries to fail and to need a developer: the steps say what to
look for. `docs/BUILD_REPORT.md` says what was and was not verified.

**Do not let a real customer write to the bot before step 41.** Until then, use only your own
phone, email address, test Page and test business.

Words used below:

- **The command computer**: the computer you run commands from (step 2). Commands are typed in
  a terminal in the folder of the repository.
- **`.env.local`**: a file in the repository folder on the command computer that holds the
  variables the commands need. It is never committed or shared.
- **Vercel variables**: Vercel dashboard, your project, Settings, Environment Variables. Unless
  a step says otherwise, add each variable for the **Production** environment. Variables whose
  name starts with `NEXT_PUBLIC_` take effect only after the next deployment.
- **`<APP_URL>`**: the public address of the deployment, for example `https://bot.youragency.com`.

## Part 1. Accounts and secrets

### 1. Make a vault for the launch's secrets

Create a new vault (or a shared folder) in your password manager, named for example "Reply bot
production". Every key, password and token in this checklist goes there, and nowhere else: not
in email, chat or documents. The most important one is the credential encryption key of step 6:
without it, every connected channel, calendar and CRM has to be connected again.

### 2. Prepare the command computer

A Mac or Linux computer (or Windows with WSL) that you trust. Install Node.js 22
(https://nodejs.org), pnpm 10 (`npm install --global pnpm@10`), Git and the PostgreSQL client
tools (`psql`, `pg_dump`). Then get the code and its dependencies:

```
git clone <the repository's URL> reply-bot
```

```
cd reply-bot && pnpm install
```

Then create `.env.local` from the template; you fill it in step 16:

```
cp .env.example .env.local
```

Optional, to see the product on this computer before any account exists (needs Docker or a
local PostgreSQL 16; see "Local development" at the end):

```
pnpm services:up && pnpm db:migrate && pnpm db:seed && pnpm dev
```

### 3. Require the automatic checks on GitHub

On GitHub, the repository's Settings, Branches (or Rules): add a rule for `main` that requires
the check `verify / pnpm verify` before merging. The workflow needs no secrets. It was checked
for syntax only and has never run on GitHub: open any pull request and confirm that the
`verify` workflow runs and passes.

### 4. Claude API key

- **Where:** https://platform.claude.com, Settings, API keys. Before creating the key, open
  Settings, Data retention: the product's default reply model, `claude-fable-5-2`, is refused
  (HTTP 400) for organizations or workspaces without 30-day data retention. In Settings,
  Capabilities, check that **web search is enabled** (playbook generation needs it; an
  administrator can switch it off, and then every generation fails with a 400 that says so)
  and that no domain restriction shuts out trade associations or cost guides. Web search is
  billed per search on top of the tokens (the live page said $10 per 1,000 searches on
  2026-11-12). The evaluation suite (step 25) also uses `claude-opus-5-5` for its simulated
  customers and judge, so the organization needs access to both models.
- **Variable:** `ANTHROPIC_API_KEY`. Leave `AI_MODEL_MODE` unset: with a key the bot uses the
  Claude API.
- **Proved by:** step 24.

### 5. Supabase project

- **What:** a Supabase project (PostgreSQL 15 or newer) for production. A second one for
  staging is optional.
- **Where:** https://supabase.com/dashboard, New project. Then, in that project:
  1. Project Settings, API: copy the Project URL, the anon (publishable) key, the service_role
     (secret) key and the JWT secret.
  2. Project Settings, Database, Connection string: copy the _Transaction pooler_ string (port
     6543) and the _Direct connection_ string (port 5432), both for the role `postgres`.
  3. Authentication, Sign In / Providers: keep Email enabled and switch **off** "Allow new
     users to sign up". Accounts are created by the agency; there is no public sign-up.
  4. Authentication, URL Configuration: set Site URL to `<APP_URL>` and add
     `<APP_URL>/auth/callback` and `<APP_URL>/auth/confirm` to Redirect URLs.
     Then, in Authentication, Emails (the admin panel's People screens send these; a link
     must come back to the app's `/auth/confirm` with a token hash, because an invitation is
     sent by the server and the person's browser holds no sign-in code to finish another kind
     of link):
     - Templates, **Invite user:** make the link
       `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite`, and let the text
       say which agency invites them and that the link expires (Supabase's default is 24 hours).
     - Templates, **Magic Link:** make the link
       `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email`. The sign-in
       form's emailed link and the People screens' link for someone who already has an account
       both use it.
     - SMTP Settings: set up your own email sender (the alert sender of step 14 will do).
       Supabase's built-in sender is for trials and sends only a few emails an hour, which runs
       out with the first invitations. The app limits each person to 20 invitations a day on
       its own.
  5. Storage: create a **private** bucket named `attachments`. Add no policies to it.
  6. Project Settings, API (Data API): remove `public` from "Exposed schemas" (or switch the
     Data API off). The app never uses Supabase's REST or GraphQL API: it reads and writes
     through its own database connection. Left on, any signed-in person can query the tables
     row-level security lets them read with their own session, past the admin panel's finer
     permissions: a client user can read every conversation, lead and lead report of their
     own business whatever `client_portal.*` says (THREAT_MODEL 2.2 and 4.14), and agency
     staff can write business-level setting rows the store never validated (they are ignored
     when read, DECISIONS 42). Auth, Storage and Realtime do not need the Data API. Until row
     level security follows the portal settings, an agency that must hide lead reports from a
     client's staff should not give those people logins.
  7. Project Settings, Realtime: keep "Allow public access" on (the website chat's live
     replies use a public broadcast channel) and Postgres changes on (the inbox's live
     updates).
  8. Database, Backups: keep the scheduled backups on, and turn on point-in-time recovery if
     the agency can afford it (`docs/BACKUP_RESTORE.md`).
- **Variables:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY` (server only: it bypasses row-level security; the app uses it on
  the server for file storage and to invite people, and it must never get a `NEXT_PUBLIC_`
  name), `SUPABASE_JWT_SECRET`, `DATABASE_URL` (the transaction pooler
  string), `DATABASE_URL_DIRECT` (the direct string), `SUPABASE_STORAGE_BUCKET` (only if the
  bucket has another name).
- **Proved by:** steps 17, 20, 21 and 27.

### 6. Generate the app's own secrets

Run each command once and store each result in the vault with its name:

```
openssl rand -base64 32
```

for `CREDENTIALS_ENCRYPTION_KEY`: the key that encrypts stored channel and integration
credentials (OAuth tokens, page tokens, IMAP and SMTP passwords, CRM keys) and signs the OAuth
state. Without it every stored credential is unreadable and each client has to reconnect. Its
id, `CREDENTIALS_ENCRYPTION_KEY_ID`, may stay unset (default `k1`). Rotating it later is in
`docs/RUNBOOK.md`.

```
openssl rand -base64 48
```

for `TEST_CHANNEL_SECRET` (the built-in test channel used by the test chat), and once more for
`WIDGET_SESSION_SECRET` (website chat sessions; without it a hosted deployment has no website
chat and its API answers 503; changing it later ends every visitor's session).

```
openssl rand -base64 32
```

for `HEALTH_CHECK_TOKEN` (the readiness check's details, step 21), and once more for
`MICROSOFT_GRAPH_CLIENT_STATE` (step 12).

```
openssl rand -hex 24
```

for `META_WEBHOOK_VERIFY_TOKEN` (step 10).

### 7. Inngest account (background jobs)

- **What:** Inngest Cloud runs the durable jobs: the reply turn, sending, retries, follow-ups,
  emergencies and the sweepers. Without it a hosted deployment stores incoming messages but
  never answers (webhooks answer 500 so providers keep retrying).
- **Where:** https://app.inngest.com, create an app, or install the Inngest integration from
  the Vercel Marketplace (it sets the two keys and syncs the app on every deploy). Event key:
  Manage, Event Keys. Signing key: Manage, Signing Key.
- **Variables:** `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` (and
  `INNGEST_SIGNING_KEY_FALLBACK` during a key rotation).
- **Proved by:** steps 19 and 22. The jobs ran only against the Inngest dev server on the build
  computer (`autobuild/reports/C3.md`), never against Inngest Cloud.

### 8. Sentry project (error reports)

- **Where:** https://sentry.io, create a project (platform "Node.js") and copy its DSN
  (Project settings, Client Keys).
- **Variable:** `SENTRY_DSN`. Without it nothing is reported (errors stay in the logs). Events
  are built and scrubbed by the app's own client, so no Sentry build plugin is needed and
  `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and `SENTRY_PROJECT` stay unused. `NEXT_PUBLIC_SENTRY_DSN`
  is not used yet: errors in the browser are not reported (THREAT_MODEL 4.10).
- **Proved by:** step 35.

### 9. Vercel project (hosting)

- **Where:** https://vercel.com, a **Pro** plan (the job route needs a maximum duration of 300
  seconds, which the Hobby plan does not allow). Add New, Project, import the GitHub
  repository. Settings, General: Root Directory `apps/web` (keep "Include files outside the
  root directory" on), Framework Next.js, Node.js version 22.x. Leave the install and build
  commands at their defaults.
- **Domain:** Settings, Domains: add the address that becomes `<APP_URL>`.
- **Variables:** `APP_URL` and `NEXT_PUBLIC_APP_URL`, both `<APP_URL>`.

### 10. Meta app (WhatsApp, Messenger, Instagram)

- **Where:** https://developers.facebook.com, My Apps, Create App, type Business. Add the
  products WhatsApp, Messenger and Instagram (use cases "Engage with customers on Messenger
  from Meta" and the Instagram messaging one). Start **Business verification** of the
  agency's business portfolio at once: it can take days. Onboarding client numbers through
  Embedded Signup also needs **Tech Provider** status. App Review comes later (step 36).
- **Webhooks** (after the first deployment, step 18; Meta checks the URL when you save):
  - WhatsApp, Configuration: callback URL `<APP_URL>/api/webhooks/whatsapp`, verify token =
    `META_WEBHOOK_VERIFY_TOKEN`. Subscribe the fields `messages`,
    `message_template_status_update`, `account_update`, `phone_number_quality_update` and,
    for numbers that also use the WhatsApp Business app, `smb_message_echoes`.
  - App Dashboard, Webhooks: object **Page**, callback `<APP_URL>/api/webhooks/messenger`;
    object **Instagram**, callback `<APP_URL>/api/webhooks/instagram`; the same verify token.
    Subscribe the Page fields `messages`, `message_echoes`, `message_deliveries`,
    `message_reads`, `message_reactions`, `messaging_postbacks`, `messaging_referrals`,
    `messaging_policy_enforcement`, `standby`, and the Instagram fields `messages`,
    `messaging_postbacks`, `message_reactions`, `messaging_referral`, `messaging_seen`,
    `standby`. Connecting a Page later subscribes it to the app (`subscribed_apps`).
  - Meta signs every delivery with the app secret.
- **Embedded Signup** (WhatsApp): Facebook Login for Business, Configurations, create one for
  "WhatsApp Embedded Signup"; its id is `META_WHATSAPP_SIGNUP_CONFIG_ID`. Add the app's domain
  to the allowed domains.
- **Facebook Login for Business** (Messenger and Instagram): Configurations, create one with a
  **System-user access token** (never expires), assets Pages and Instagram accounts, and the
  permissions of step 36. Its id is `META_LOGIN_CONFIG_ID`.
- **Variables:** `META_APP_ID` and `NEXT_PUBLIC_META_APP_ID` (App settings, Basic; Messenger
  echoes of the app's own messages carry it, and without it the bot cannot tell its own
  echoes from another app's), `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` (step 6),
  `META_WHATSAPP_SIGNUP_CONFIG_ID`, `META_LOGIN_CONFIG_ID`; optionally
  `META_GRAPH_API_VERSION` (default `v27.0`, the version Meta's docs used on 2026-11-12).
  For the live checks of step 29 and 30, on the command computer only:
  `META_TEST_WHATSAPP_PHONE_NUMBER_ID`, `META_TEST_WHATSAPP_ACCESS_TOKEN` (WhatsApp, API Setup:
  a temporary token, or a system user token), `META_TEST_WHATSAPP_BUSINESS_ACCOUNT_ID`,
  `META_TEST_WHATSAPP_RECIPIENT` (your own phone, added as a test recipient on API Setup),
  `META_TEST_PAGE_ID`, `META_TEST_PAGE_ACCESS_TOKEN` (Graph API Explorer, your app, Get Page
  Access Token for the test Page), `META_TEST_INSTAGRAM_ACCOUNT_ID` (the Page's
  `instagram_business_account`).
- **Proved by:** steps 29, 30 and 36.

### 11. Google Cloud project (Gmail and Google Calendar)

- **Where:** https://console.cloud.google.com, one project for both.
  1. APIs: enable the **Gmail API**, the **Cloud Pub/Sub API** and the **Google Calendar API**.
  2. OAuth consent screen: External (or Internal for one Workspace), app name, support email,
     and the scopes `https://www.googleapis.com/auth/gmail.readonly`,
     `https://www.googleapis.com/auth/gmail.send` (both **restricted**: until Google verifies
     the app, with a security assessment, only test users you list can connect, at most 100),
     `https://www.googleapis.com/auth/calendar.readonly` and
     `https://www.googleapis.com/auth/calendar.events` (both "sensitive": verification without
     the security assessment).
  3. Credentials, OAuth client ID, type Web application, authorized redirect URIs
     `<APP_URL>/api/oauth/email/google/callback` and
     `<APP_URL>/api/oauth/calendar/google/callback`.
  4. Pub/Sub (push notifications for Gmail; without it Gmail inboxes are polled every
     minute): create a topic (for example `projects/<project>/topics/gmail-push`) and give
     `gmail-api-push@system.gserviceaccount.com` the **Pub/Sub Publisher** role on it. Create a
     **push** subscription to it with endpoint `<APP_URL>/api/webhooks/email/gmail`, **Enable
     authentication** on, a service account you create for it, and the audience left empty
     (it then is the endpoint URL) or set and copied into `GOOGLE_PUBSUB_PUSH_AUDIENCE`.
- **Variables:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_PUBSUB_TOPIC`,
  `GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT` (the push service account's email),
  `GOOGLE_PUBSUB_PUSH_AUDIENCE` (optional).
- **Proved by:** steps 31 and 32.

### 12. Microsoft Entra app (Outlook mail and calendar)

- **Where:** https://entra.microsoft.com, App registrations, New registration: accounts in any
  organizational directory and personal Microsoft accounts. Web redirect URIs
  `<APP_URL>/api/oauth/email/microsoft/callback` and
  `<APP_URL>/api/oauth/calendar/microsoft/callback`. Certificates & secrets: a client secret.
  API permissions, delegated Microsoft Graph: `offline_access`, `User.Read`, `Mail.Read`,
  `Mail.Send`, `Calendars.ReadWrite` (a tenant admin may have to consent for work accounts).
  Change notifications need `<APP_URL>` to be public https; otherwise Microsoft inboxes are
  polled every minute.
- **Variables:** `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID`
  (`common`), `MICROSOFT_GRAPH_CLIENT_STATE` (step 6).
- **Proved by:** steps 31 and 32.

### 13. Twilio (alert texts and emergency calls)

- **Where:** https://www.twilio.com: an account, an SMS- and voice-capable US number, and **A2P
  10DLC registration** of that number (brand and campaign, category "account notifications";
  register the app's domain in the campaign's sample messages, because alert texts carry a
  link to it). US carriers block unregistered application texts. A trial account can only
  reach verified numbers. In the number's settings set "A message comes in" to
  `POST <APP_URL>/api/handoff/twilio/sms` (replies with an alert's code acknowledge an
  emergency). Calls and status callbacks need no console setting (only when `<APP_URL>` is
  https). Optional: a Messaging Service with the number in it.
- **Set a spend limit now:** Billing, Usage triggers (or a monthly limit). Anyone who describes
  an emergency to a bot pages the escalation chain, the app does not ration emergencies, and a
  flood of made-up ones is bounded only by the per-customer and per-business limits
  (THREAT_MODEL 4.1b).
- **Variables:** `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (also checks Twilio's webhook
  signatures; keep it secret and rotate it if it leaks), `TWILIO_FROM_NUMBER`,
  `TWILIO_MESSAGING_SERVICE_SID` (optional).
- **Proved by:** step 33.

### 14. Alert email sender, and WhatsApp alerts (optional)

- **Email:** any SMTP server that may send as your alert address (Postmark, Amazon SES, a Google
  Workspace relay...), with SPF and DKIM for that domain so alerts do not land in spam.
  Variables: `ALERT_SMTP_URL`, `ALERT_EMAIL_FROM`.
- **WhatsApp alerts (optional):** the agency's own WhatsApp Business number on the Cloud API
  (the Meta app of step 10, a system user token with `whatsapp_business_messaging`) and an
  approved **utility** template, for example name `staff_alert`, language `en_US`, body
  `New alert: {{1}}` (one parameter; Meta may ask for more fixed text around it). Variables:
  `ALERT_WHATSAPP_PHONE_NUMBER_ID`, `ALERT_WHATSAPP_ACCESS_TOKEN`, `ALERT_WHATSAPP_TEMPLATE`,
  `ALERT_WHATSAPP_TEMPLATE_LANGUAGE` (default `en_US`).
- A missing transport is not an error: its alerts are recorded as `not_configured` and the
  emergency chain moves on to the next person.
- **Proved by:** step 33.

### 15. Optional accounts: Calendly, voice transcription, CRMs

Only what the pilot business needs. Everything here can be added later.

- **Calendly, OAuth** (an agency connecting many clients): register an app at
  https://developer.calendly.com with the redirect URI
  `<APP_URL>/api/oauth/calendar/calendly/callback`. Variables: `CALENDLY_CLIENT_ID`,
  `CALENDLY_CLIENT_SECRET`, and the app's webhook signing key (shown once at creation;
  Calendly support re-issues it) as `CALENDLY_WEBHOOK_SIGNING_KEY`. Without the app, agency
  staff paste a client's personal access token instead (Calendly, Integrations, API and
  webhooks); each such connection's webhook gets its own signing key.
- **Voice messages on WhatsApp:** a Deepgram key (https://console.deepgram.com, API Keys) as
  `DEEPGRAM_API_KEY`, and later the business setting `channels.whatsapp.voice_messages` =
  "transcribe". Without it the bot asks customers to type. The Deepgram request
  (`POST https://api.deepgram.com/v1/listen?model=nova-3`) was written from Deepgram's
  documented API and tested only against a recorded response.
- **CRMs** (all optional; a CRM without its variables offers only what needs none;
  `docs/INTEGRATIONS.md` has the details per vendor):
  1. **HubSpot:** for OAuth, a public app in a HubSpot developer account (free) with redirect
     URL `<APP_URL>/api/oauth/crm/hubspot/callback` and scopes
     `oauth crm.objects.contacts.read crm.objects.contacts.write`; variables
     `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`. No marketplace review is needed for the
     agency's own accounts. Without it, businesses paste a private app token (Settings,
     Integrations, Private apps).
  2. **GoHighLevel:** for OAuth, a Marketplace app (sub-account level, private) with redirect
     URL `<APP_URL>/api/oauth/crm/gohighlevel/callback` and scopes
     `contacts.readonly contacts.write opportunities.write locations.readonly`; variables
     `GOHIGHLEVEL_CLIENT_ID`, `GOHIGHLEVEL_CLIENT_SECRET`. Without it, a sub-account's Private
     Integration Token and location id.
  3. **Jobber:** an app in Jobber's Developer Center (OAuth only; scopes: clients read and
     write, requests write) with callback `<APP_URL>/api/oauth/crm/jobber/callback`; variables
     `JOBBER_CLIENT_ID`, `JOBBER_CLIENT_SECRET`. Unpublished apps can be installed by the
     agency's own accounts; the App Marketplace needs Jobber's review.
  4. **Housecall Pro:** nothing for the agency; each business needs the **MAX plan**, an API
     key (App Store, API), and **API Leads** switched on in the Job Inbox settings. The
     variables `HOUSECALL_PRO_CLIENT_ID` and `HOUSECALL_PRO_CLIENT_SECRET` stay unset.
  5. **ServiceTitan:** **approval required.** Create the app in ServiceTitan's Developer Portal
     (Integration environment first; CRM bookings scopes), get it approved for Production, and
     set `SERVICETITAN_APP_KEY` and `SERVICETITAN_ENVIRONMENT=production`. Each tenant connects
     the app (API Application Access), gives the business its tenant id, client id and secret,
     and creates a booking provider for us.

## Part 2. Environment variables

### 16. Paste the variables into Vercel and into `.env.local`

Add every variable you have a value for to the Vercel variables (Production), and the same
values to `.env.local` on the command computer (the database commands and live checks read
it). The full list with a description of each is in `.env.example`; the source of each value is
the step named here.

| Variable                                                                                                                                                   | From step           | Required                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------- |
| `APP_URL`, `NEXT_PUBLIC_APP_URL`                                                                                                                           | 9                   | yes                             |
| `DATABASE_URL`, `DATABASE_URL_DIRECT`                                                                                                                      | 5                   | yes                             |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`                                            | 5                   | yes                             |
| `SUPABASE_STORAGE_BUCKET`                                                                                                                                  | 5                   | only for another bucket name    |
| `CREDENTIALS_ENCRYPTION_KEY` (`CREDENTIALS_ENCRYPTION_KEY_ID`, `CREDENTIALS_ENCRYPTION_OLD_KEYS` only after a rotation)                                    | 6                   | yes                             |
| `TEST_CHANNEL_SECRET`, `WIDGET_SESSION_SECRET`, `HEALTH_CHECK_TOKEN`                                                                                       | 6                   | yes                             |
| `ANTHROPIC_API_KEY`                                                                                                                                        | 4                   | yes                             |
| `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`                                                                                                                 | 7                   | yes (set by the integration)    |
| `SENTRY_DSN`                                                                                                                                               | 8                   | strongly advised                |
| `META_APP_ID`, `NEXT_PUBLIC_META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `META_WHATSAPP_SIGNUP_CONFIG_ID`, `META_LOGIN_CONFIG_ID`          | 10 (and 6)          | for WhatsApp, Messenger, Instagram |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_PUBSUB_TOPIC`, `GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT`, `GOOGLE_PUBSUB_PUSH_AUDIENCE`                      | 11                  | for Gmail and Google Calendar   |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID`, `MICROSOFT_GRAPH_CLIENT_STATE`                                                    | 12 (and 6)          | for Outlook mail and calendar   |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `TWILIO_MESSAGING_SERVICE_SID`                                                            | 13                  | for texts and calls             |
| `ALERT_SMTP_URL`, `ALERT_EMAIL_FROM`, `ALERT_WHATSAPP_PHONE_NUMBER_ID`, `ALERT_WHATSAPP_ACCESS_TOKEN`, `ALERT_WHATSAPP_TEMPLATE`, `ALERT_WHATSAPP_TEMPLATE_LANGUAGE` | 14         | for alert email and WhatsApp    |
| `CALENDLY_CLIENT_ID`, `CALENDLY_CLIENT_SECRET`, `CALENDLY_WEBHOOK_SIGNING_KEY`, `DEEPGRAM_API_KEY`, the CRM variables                                      | 15                  | optional                        |
| `TRUSTED_PROXY_HOPS`, `CLIENT_IP_HEADER`                                                                                                                   | 21                  | only behind a CDN               |
| `META_TEST_*`                                                                                                                                              | 10                  | `.env.local` only, for checks   |

**Never set these on a deployment:** `DEVELOPMENT_MODE` (it switches on the in-process job
runner, the offline stand-in model, local storage and per-process secrets, and
`/api/health/ready` fails while it is on), `LOCAL_AUTH_SECRET`, `AI_MODEL_MODE`,
`INNGEST_DEV`, `INNGEST_BASE_URL`, `DEV_META_GRAPH_URL`, `DEV_LOCAL_MAIL_PORTS`,
`DEV_LOCAL_MAIL_CA_FILE`, `TEST_DATABASE_URL`, `SEED_USER_PASSWORD`. The `DEV_*` ones are
ignored on a deployment anyway; they exist for the browser tests.

## Part 3. Deploy

None of these commands has ever been run: the build never touches a hosted system.

### 17. Create the production database's tables

On the command computer, with `.env.local` filled in (step 16):

```
pnpm db:migrate
```

It creates the schema, the row-level security policies and the role `app_system`. Then check
the database:

```
pnpm db:doctor
```

**Pass:** every line says `ok`. It proves what could only be tested on plain PostgreSQL so far:
that the `postgres` role may switch to `authenticated` and `app_system`, that every table has
forced row-level security, that privileges match the policies, the trigger on `auth.users`,
that Supabase's default grants were revoked, and (last line, "Credential encryption key") that
the configured encryption key works. After `pnpm db:migrate`, Supabase's Database, Replication
page must list `conversations`, `messages` and `takeover_locks` in the `supabase_realtime`
publication.

Optional, on a **staging** project only, the demo agency with its four users (it refuses to run
in production):

```
SEED_USER_PASSWORD=<12 or more characters> pnpm db:seed
```

### 18. Deploy to production

Either merge to `main` with the Vercel GitHub integration on (Vercel deploys every push to
`main`), or deploy from the command computer:

```
npm install --global vercel
```

```
vercel login
```

```
vercel link
```

```
vercel deploy --prod
```

**Pass:** the deployment finishes and `<APP_URL>/sign-in` shows the sign-in page.
`docs/RUNBOOK.md` has rollback and every later deployment.

### 19. Connect Inngest to the deployment, and turn on its alerts

With the Vercel integration, Inngest syncs the app on every deploy. Without it, open the
Inngest dashboard, Apps, Sync new app, `<APP_URL>/api/inngest`, or run:

```
curl -X PUT <APP_URL>/api/inngest
```

**Pass:** the Inngest dashboard lists the app's functions, among them `pipeline-reply`,
`pipeline-send` and `pipeline-sweeper`, which runs every minute. Then, in Inngest's settings,
turn on its notifications for failed functions and for an app that is not synced: the app's
own readiness check notices a runner that never runs only after half an hour (step 21).

### 20. Create the first agency admin and sign in

Nothing can be done in the admin panel before this step. In Supabase, Authentication, Users,
Add user: your email address and a password, tick "Auto Confirm User". Then on the command
computer (with `.env.local` pointing at production):

```
pnpm db:create-admin --agency "Your Agency" --slug your-agency --email you@example.com
```

**Pass:** you can sign in at `<APP_URL>/sign-in` with the password, and again with an emailed
link (sign out, enter only the email).

Other people are added in the admin panel (`docs/ONBOARDING.md`, "People and logins"): agency
admins and members on **People**, a business's client owner and staff on that business's
**People** tab. Each gets an email from Supabase (step 5.4): an invitation, or a sign-in link
if they already have an account. Agency admins add, change and remove; members only see the
lists. A second agency admin is worth having from the start: nobody can change their own access,
so only another admin can.

1. The invitation emails, without giving anyone access (an address of yours that has no
   account yet; run it twice to see both emails):

   ```
   pnpm --filter @repo/db live:invite --email you+invite@example.com
   ```

   **Pass:** the first run says Supabase sent the "Invite user" email, the second the "Magic
   Link" email; each link lands on `<APP_URL>/auth/confirm` and ends on the sign-in page with
   "not linked to an agency or business yet" (the address belongs to nothing).
2. In the admin panel, **People**: add a colleague (or a second address of yours) as agency
   member. **Pass:** the email arrives, the link signs them in, they see every business and the
   People page without its add form. Then remove them: **pass** when their next click ends on
   the sign-in page.
3. The audit log (**Audit log**, action `agency_membership.`) lists the grant and the removal
   with your name.

The built-in sender limits and the templates of step 5 are what fail most often here: if no
email arrives, check Supabase's Authentication logs.

### 21. Check the deployment from outside

1. Readiness, with the token of step 6:

   ```
   curl -s -H "authorization: Bearer $HEALTH_CHECK_TOKEN" <APP_URL>/api/health/ready
   ```

   **Pass:** `"status":"ready"` and a list of checks. The same command without the header must
   answer the status alone. A warning about businesses whose emergencies reach nobody is
   expected until step 23; a failing `unanswered` check means customer messages waited more
   than 30 minutes without a reply turn: the job runner is not running (`docs/RUNBOOK.md`).

2. Security headers:

   ```
   curl -sI <APP_URL>/sign-in
   ```

   **Pass:** `x-frame-options: DENY`, `x-content-type-options: nosniff` and a `referrer-policy`.

3. The Supabase Data API is closed (step 5.6):

   ```
   curl -s "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/conversations?select=id&limit=1" -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY"
   ```

   **Pass:** an error saying the schema is not exposed, not rows and not `[]`.

4. An uptime monitor (any service: Better Stack, UptimeRobot, Vercel's own): watch
   `<APP_URL>/api/health` (liveness) and `<APP_URL>/api/health/ready` (503 when not ready)
   every few minutes, and alert the person on duty.

5. Vercel, Project, Firewall, Rules: a rate limit on the path prefix `/api/widget/v1`, for
   example 300 requests per minute per IP address. The app's own per-address limit counts per
   server instance only (THREAT_MODEL 4.2 and 4.3).

6. Proxies: leave `TRUSTED_PROXY_HOPS` unset (1) on Vercel alone. Behind a CDN that appends to
   `X-Forwarded-For` (Cloudflare in front of Vercel), set it to 2, or set `CLIENT_IP_HEADER` to
   the header that CDN overwrites with the visitor's address (`cf-connecting-ip`).

### 22. The live round trip (after this and every later deployment)

From the command computer (with the production `DATABASE_URL` in `.env.local`):

```
APP_URL=<APP_URL> TEST_CHANNEL_SECRET=<the deployment's value> pnpm --filter @repo/pipeline live:roundtrip
```

It posts three quick messages and a duplicate to the test channel's webhook. **Pass:** it
reports exactly one reply answering all three, and the Inngest dashboard shows the runs of
`pipeline-reply` and `pipeline-send`. This is also the check that Inngest really runs the jobs:
readiness cannot see a runner that accepts events and never runs them until customers have
waited half an hour (THREAT_MODEL 4.16).

## Part 4. Connect one pilot business

### 23. Onboard the pilot business

Follow `docs/ONBOARDING.md` for one real client business, with these limits until step 41:

- Connect only your own test number, test Page and test inbox, and do not put the website chat
  on the client's site yet, so that no real customer reaches the bot. (Pausing the business on
  its page stops every reply, the test chat's included.)
- In its alert contacts, fill the emergency escalation chain and the agency-wide fallback
  contacts (`emergency.escalation_chain`, `emergency.fallback_contacts`): **both start empty**,
  and until someone is entered an emergency alerts nobody by phone (a critical alert appears in
  the admin panel only, readiness lists the business, and the wizard asks for an explicit
  acknowledgement).
- Client logins (optional): switch on `client_portal.enabled` in the business's settings,
  then add the client's owner on the business's **People** tab. **Pass:** they sign in with the
  emailed link and see this business only, with what `client_portal.*` allows. Read step 5.6
  first: until the Data API is closed, a client login reads more than the portal shows.
- Website chat: put every address the business's site is served from on its allowed list
  (`channels.widget.allowed_origins`, for example `https://www.example.com` and
  `https://example.com`); with an empty list the chat shows nowhere.

**Pass:** the business's page shows its channels connected, its playbook, its knowledge and
"Alert contacts" ready; the wizard's test chat answers.

## Part 5. Live checks: each outside service for the first time

Each check below was skipped in the build because it needs the real service. Run them in this
order; where one fails, stop and give the output to a developer.

### 24. The Claude API writes real replies

```
pnpm --filter @repo/ai live:conversations
```

It plays nine scripted customers (roofing, HVAC, electrical and remodeling leads; a gas smell at
night; a prompt injection; an angry customer; off-topic questions; spam) against the API in dry
run: nothing is sent to anyone and nothing is written to a database. It prints each transcript,
the tool calls and the token counts. **Pass:** it ends without a failure; it fails when a
conversation does not behave as specified or when a model call after the first of a
conversation reads nothing from the prompt cache. Expect a few cents per conversation. Read the
transcripts once: they are the first real look at how the bot sounds. One conversation:

```
pnpm --filter @repo/ai live:conversations emergency
```

The prompt as the model gets it:

```
pnpm --filter @repo/ai prompt:fingerprint --print
```

- Every request fails with a 400 that mentions data retention: the workspace lacks 30-day
  retention (step 4).
- A 400 about `strict` or structured outputs: the organization uses customer-managed
  encryption keys; run with `--no-strict` and tell a developer, who sets `strictTools: false`
  where the engine is created (`packages/pipeline/src/composition`).
- A slow first call is the one-time compilation of the tool schemas; later calls reuse it for
  24 hours.
- Not covered by this check: photo analysis with real images (send a photo through the website
  chat in step 28) and the prices in `packages/ai/src/model/pricing.ts`, which are list prices
  from the API reference the build used.

### 25. The evaluation suite, its baseline, and the check on every pull request

No quality number exists yet: every evaluation so far ran against stand-ins that evaluate
nothing. Run on the command computer with local PostgreSQL (`pnpm services:up`; the
evaluation plays in a throwaway database and sends nothing). Steps, in this order:

1. Check the judge before trusting it (eight judge calls, about a minute):

   ```
   pnpm eval --calibrate-judge
   ```

   It shows the judge eight hand-made conversations with one known fault each and one clean
   one. **Pass:** it agrees on all of them. Where it does not, read what it said: either the
   rubric needs sharpening (`packages/evals/src/grade/rubric.ts`) or the expectation was wrong
   (`packages/evals/src/calibration/probes.ts`).

2. A first, smaller run (24 conversations), then the whole suite (72):

   ```
   pnpm eval --core
   ```

   ```
   pnpm eval
   ```

   Each prints one line per conversation, the verdict and the measured cost, and writes
   `evals-output/<run>/report.html`. Open the report and read conversations, the failing ones
   first: this is what the agency's clients will get.

3. Expect failures on the first run: the prompt has never been read by the model it was written
   for. A developer fixes causes, not conversations: the prompt as a new version
   (`packages/ai/src/prompt/core`), or the engine, then runs again. `pnpm eval --scenario roofing.renter` replays one scenario, `--persona emergency` one kind of customer, `--resume
   <dir>` finishes a run the API interrupted. A change to a default setting needs a line in
   `docs/DECISIONS.md`.

4. **Pass:** every scenario passes with zero setting-compliance failures. Then save the
   baseline and commit it:

   ```
   pnpm eval --save-baseline
   ```

   ```
   git add packages/evals/baseline/live.json
   ```

   From then on a live run also fails when quality drops against that file.

5. On GitHub, Settings, Secrets and variables, Actions: add the same key as a repository
   secret named `ANTHROPIC_API_KEY`. The workflow `eval` then runs live on every pull request
   that touches the engine, the prompts, the playbook and knowledge code, lead scoring or the
   settings registry (until the secret exists it runs against stand-ins and says so). To spend
   less per pull request, set the repository variable `EVAL_ARGS` to `--core`. The workflow
   was checked for syntax only: open a pull request that touches `packages/ai` and confirm that
   the `eval` job runs, prints "Live evaluation" and attaches the `eval-report` artifact.

- What it costs and how long it takes: not measured. Every run prints its cost from the tokens
  the API reported; `--core` first tells you what a full run costs (three times as much).
- Every conversation "NOT PLAYED (config)": the key is missing or refused (step 4). A 400 about
  `strict`: run with `--no-strict`. Many "NOT PLAYED (serving)" lines: rate limits; lower
  `--concurrency` (default 6) and finish with `--resume`.
- The thresholds and the reply effort are decided in step 40.

### 26. Playbook generation, the website reader and the import API

No playbook has been generated by the real model. With the key set:

```
pnpm --filter @repo/knowledge live:playbook
```

It researches and writes the playbooks for roofing and pest control exactly as the job does,
without a database. For every model call it prints the step, the stop reason, the searches,
the tokens and the seconds; then the size of each section, the price norms and the sources.
**Pass:** no failure (it fails when a document is not complete, breaks a rule or cites a page
the search did not return). Expect several minutes and a few dollars per trade. Read both
playbooks once (`--out <folder>` writes them as JSON). One trade: `live:playbook "Pest
control"`; regions for the price norms: `--region CO --region MN`.

- A call must finish within 270 seconds (one job step runs inside one request of
  `/api/inngest`, maximum 300). If a research step is slower, lower "Web searches per research
  step" (`knowledge.playbook_research_searches`) or the effort of "Playbook generation"
  (`model.playbook.effort`) in the agency's settings; the command has the same options
  (`--searches 3`, `--effort medium`).
- A 400 about `strict`: `--no-strict`, as in step 24. A 400 that mentions `allowed_callers` or
  the tool version: tell a developer (the tool definition is `webSearchTool()` in
  `packages/knowledge/src/playbooks/generate.ts`).
- Then onboard a business in a new segment in the admin panel and watch the run finish: the
  playbook editor shows version 1 with origin "generated".

The website reader against a client's real site (nothing is stored):

```
pnpm --filter @repo/knowledge live:crawl https://www.their-website.com --pages 5
```

**Pass:** it prints, per page, the facts it would store and what the checks dropped, and it
refuses `http://localhost/` and `http://169.254.169.254/` (try both). Reading websites is off by
default: switch on "Read the business website" (`knowledge.website_crawl`) per business or for
the agency.

The import API: create a key in the admin panel, or with:

```
pnpm --filter @repo/knowledge api-key --slug <agency-slug> --name "Lead-gen sync"
```

The key is printed once. Then send the agency's lead-generation data (replace the key and the
business's reference; `externalRef` is the business's id in your own data):

```
curl -X POST <APP_URL>/api/v1/knowledge/import -H "Authorization: Bearer hsrb_..." -H "Content-Type: application/json" -d '{"businesses":[{"externalRef":"crm-123","facts":[{"category":"services","title":"Services","content":"Roof repair and replacement."}]}]}'
```

```
curl -X POST "<APP_URL>/api/v1/knowledge/import/csv?external_ref=crm-123" -H "Authorization: Bearer hsrb_..." -H "Content-Type: text/csv" --data-binary @facts.csv
```

**Pass:** the answer lists what was imported and every record that was refused, with the
reason. Give the agency's lead-generation tool the first URL.

### 27. Supabase sign-in, file storage and live updates

- **Sign-in:** step 20 proved password and emailed-link sign-in, and the invitations of the
  People screens; step 23 gives a client owner a login.
- **File storage:** send a photo through the website chat (step 28). **Pass:** the photo shows
  in the conversation in the admin panel (it is stored in the private bucket and shown through a
  short-lived link).
- **Inbox live updates:** sign in as agency staff in two browsers, open the same conversation in
  both, and write as the customer from the test chat. **Pass:** the message appears within about
  a second without a reload; the corner of the screen says "Live"; the browser's network tab
  shows one websocket to `<project>.supabase.co/realtime/v1/websocket` with a `phx_reply`
  `"status":"ok"` for `realtime:admin:conversation:<id>`. Sign in as a client user of another
  business and confirm their socket receives no events for it. Without Realtime the page polls
  (the conversation every 4 s, the inbox every 10 s) and says "Updates every N s". This was
  built from memory of `@supabase/ssr` and Realtime's `postgres_changes` API, never against a
  live project.

### 28. The website chat on a real site

Paste the snippet the admin panel shows (the business's Channels page) into a test page on a
site on the business's allowed list (step 23), and chat; send a photo. **Pass:** replies
appear; with Realtime configured the browser's network tab shows one websocket to
`<project>.supabase.co/realtime/v1/websocket` whose frames include a `phx_reply` with
`"status":"ok"` for the `realtime:widget-...` topic, and no `GET /api/widget/v1/messages` polls
every 1.5 s. If the project refuses the join, the widget polls (every 6 s while open): it still
works, but tell a developer, because the broadcast endpoint
(`POST {project}/realtime/v1/api/broadcast`) and the websocket join (Phoenix, `vsn=1.0.0`,
public broadcast channel) were written from memory of the protocol. The browser sends the key
as the join's `access_token` only when it is a JWT (a legacy anon key); with a publishable key
(`sb_publishable_...`) it relies on the `apikey` parameter.

### 29. WhatsApp

1. The Cloud API with Meta's test number (the `META_TEST_WHATSAPP_*` variables of step 10 in
   `.env.local`):

   ```
   pnpm --filter @repo/channel-whatsapp live:check
   ```

   It reads the test number, sends `hello_world`, a free-form text and reply buttons to your
   phone, and lists the templates. Write to the test number from your phone first, or the last
   two fail with 131047 (which also proves the window rule). **Pass:** every line `ok` and the
   messages on your phone.

2. A real conversation: point the webhook (step 10) at the deployment (or at `pnpm dev` behind
   `cloudflared tunnel --url http://localhost:3000`), and connect the test number to a test
   business:

   ```
   pnpm --filter @repo/channel-whatsapp live:check connect --business <business id>
   ```

   (The business id is in the address of its page in the admin panel, or
   `psql "$DATABASE_URL" -c "select id, name from businesses"`.) Then write to the test number
   from your phone. **Pass:** blue ticks and "typing…", one reply per burst of messages, a photo
   stored, a voice note answered with "please type" (or transcribed with Deepgram), and
   statuses moving to delivered and read in the conversation.

3. Templates: in the business's Channels page create the suggested templates, wait for
   approval (minutes), and set `channels.whatsapp.follow_up_template` and
   `channels.whatsapp.staff_reply_template` to their names. Until then, follow-ups after 24
   hours are not sent (they fail with `window_closed`, visible in the inbox). Then push the
   conversation's `last_inbound_at` back 25 hours in the database and send a follow-up or a
   manual reply. **Pass:** the template arrives instead of text.

4. Embedded Signup with a real client number, once the app has Tech Provider access.

Details to look at during check 2 (not settled by Meta's docs):

- The BSUID format: the docs give only examples (`US.13491208655302741918`, parent ids
  `US.ENT.…`); anything that is not a phone number is sent as `recipient`.
- Meta's media host names: the downloader allows `fbsbx.com`, `facebook.com`, `fbcdn.net`,
  `whatsapp.net` and `cdninstagram.com`; a photo that fails with "not one of Meta's hosts"
  means the list needs the host it names (`META_MEDIA_HOST_SUFFIXES`).
- Whether 131047 (window closed) comes back in the send response or only as a "failed" status
  webhook: run check 1 when you have not written to the test number for more than 24 hours. If
  "send free-form text" prints `FAIL ... meta_131047`, Meta answers in the response; if it
  prints `ok`, the refusal comes only as a failed status webhook and the one-minute margin of
  the send step is the only guard at the edge.
- The default waits for rate-limit codes (`packages/channels/meta/src/errors.ts`).
- Already checked against Meta's reference (2026-11-12, docs only): the `smb_message_echoes`
  payload, the inbound `from_user_id`/`user_id` fields, the `account_update` events.

### 30. Messenger and Instagram

1. The Graph API with the test Page (`META_TEST_PAGE_*`, `META_TEST_INSTAGRAM_ACCOUNT_ID` in
   `.env.local`):

   ```
   pnpm --filter @repo/channel-messenger-instagram live:check
   ```

   It reads the Page and its Instagram account and subscribes the app to the Page's fields.
   Then write to the Page from your own Messenger account and run (your id is the `sender.id`
   of your message in the app's logs of a webhook test, or in the conversation once check 2
   works):

   ```
   pnpm --filter @repo/channel-messenger-instagram live:check send --to <your PSID>
   ```

   and, after writing to the Instagram account:

   ```
   pnpm --filter @repo/channel-messenger-instagram live:check send --instagram --to <your IGSID>
   ```

   **Pass:** a text with two quick replies, "seen" and typing.

2. A real conversation on both platforms: point both webhooks (step 10) at the deployment (or
   `pnpm dev` behind `cloudflared tunnel --url http://localhost:3000`) and connect the test Page
   to a test business:

   ```
   pnpm --filter @repo/channel-messenger-instagram live:check connect --business <business id>
   ```

   Write to the Page and to the Instagram account. **Pass:** "seen" and typing, one reply per
   burst, quick replies as buttons, a photo stored, statuses moving to delivered and read. Then
   answer the customer yourself from Meta Business Suite's inbox: the reply appears in the
   conversation as a person's and the bot stays silent (a takeover with source
   `provider_inbox`).

3. Window rules: push the conversation's `last_inbound_at` back 25 hours and send a manual
   reply and a follow-up. **Pass:** the person's reply goes out tagged HUMAN_AGENT; the bot's
   fails with `window_closed`.

4. Facebook Login with a real client Page once the app has Advanced Access. On each client's
   Page: in Meta Business Suite, Settings, Messaging, leave the app as the Page's messaging app
   and make sure no other automation (Meta Business AI, another bot) answers first; for
   Instagram, Settings, Messages and story replies, Message controls, **Allow access to
   messages** must be on.

Details to look at during check 2:

- Whether Instagram echoes carry `app_id` or our `metadata` (the reference shows neither).
  Without them the bot matches an echo to what it sent (the provider id, then the words within
  30 minutes), so a person who repeats a whole bot message word for word is taken for the bot.
  Answer from the Instagram inbox and look at the webhook body for `app_id` and `metadata`.
- The Page inbox app id: the docs print `26390203743090`, the long-known id is
  `263902037430900`; both are accepted (`PAGE_INBOX_APP_IDS`).
- Messenger delivery and read watermarks against our clock (a clock ahead of Meta's leaves the
  newest message "delivered" until a later watermark).
- Instagram photo replies: the code sends the media type with `attachment_id`; if a photo reply
  fails with code 100, try `MEDIA_SHARE` in `attachmentBody`. Instagram takes only PDF as a
  file.
- Whether `/me/accounts` lists the Pages of a business integration system user token. If it
  comes back empty, the connect route answers "did not share any Facebook Page" (400), and the
  Pages have to be read from the client business instead.
- Messenger's default rate-limit waits; Instagram's 1,000-byte text limit (texts are split at
  900 characters and trimmed in bytes).

### 31. Email: Gmail, Microsoft 365 and IMAP/SMTP inboxes

1. An IMAP/SMTP inbox you own (the password is asked for on standard input):

   ```
   pnpm --filter @repo/channel-email live:check --address office@yourdomain.com --imap-host imap.yourdomain.com --smtp-host smtp.yourdomain.com --to you@gmail.com
   ```

   It logs in to both servers with the app's address and TLS rules, finds the Sent folder and
   sends a test email. Reply to it and run the command again. **Pass:** it shows the reply's
   In-Reply-To. Only standard ports (IMAP 993 or 143 with STARTTLS, SMTP 465, 587, 25 or 2525)
   and public addresses are accepted.

2. A real conversation on each connection type: in the business's Channels page connect Gmail,
   Microsoft 365 and an IMAP/SMTP inbox (`<APP_URL>` must be reachable by Google and
   Microsoft). Write to the inbox from another account. **Pass:** within a minute (push) or two
   (poll) one reply in the same thread (Gmail and Outlook show it threaded) with the signature;
   reply again and get the next answer in the thread, now quoting your words. Then answer the
   customer yourself from the mailbox: the bot stays silent in that thread (only mail found in
   the Sent folder hands over). Send yourself an out-of-office reply and a newsletter: no
   answer. Write with another person in Cc: the bot's reply goes to the sender only.

3. Microsoft's subscription lifecycle: wait for (or force, by deleting the subscription in
   Graph Explorer) a `subscriptionRemoved` notification. **Pass:** the next sync recreates the
   subscription.

Details to look at during check 2 (not verified anywhere):

- Whether Gmail's API and Exchange Online keep our `Message-ID` and the `X-HSRB-Loop` header on
  what they send. After the first bot reply on each provider: the log line
  `email.own_send_without_marker` must not appear, no takeover with source `provider_inbox`
  exists for the thread, and the bot answers the customer's next email. The same header decides
  quoting: check on each provider that the bot's answer to a customer's reply carries the quote.
  If a provider rewrote our Message-ID it never will (safe, but quoting and reply-to-all are
  then off for that provider): tell a developer.
- Whether Graph's `message: delta` returns new messages only once per folder (duplicates are
  harmless), Gmail's `history.list` on a busy mailbox, the Pub/Sub token's audience (set
  `GOOGLE_PUBSUB_PUSH_AUDIENCE` if pushes are refused with 401 and the log says `audience`),
  and real mail programs' quoting and signature styles (Gmail, Outlook, Apple Mail, iPhone).

### 32. Calendars and Calendly

1. Each provider's client against a real account, with a token from Google's OAuth Playground,
   Graph Explorer or a Calendly personal token (asked for on standard input):

   ```
   pnpm --filter @repo/scheduling live:check --provider google --write
   ```

   ```
   pnpm --filter @repo/scheduling live:check --provider microsoft --write
   ```

   ```
   pnpm --filter @repo/scheduling live:check --provider calendly --event-type https://calendly.com/<you>/<event>
   ```

   Put a tentative and an all-day event in the calendar first. **Pass:** the calendars, the next
   week's events as busy, tentative or free, a test event created once although the create is
   sent twice, moved and deleted, and a single-use link.

2. A booking through the bot: connect the calendar in the business's Integrations page, set
   `scheduling.provider`, a routing that books (`routing.*_outcome` = book a meeting) and the
   meeting settings (hours, length, buffers, lead time, travel rules; for Calendly,
   `scheduling.calendly_event_type`, for example
   `https://calendly.com/summit-roofing/estimate`), then qualify yourself in the test chat.
   **Pass:** two or three real free times; after you pick one, an event with the lead report and
   the conversation link, with you invited when the email is known; "move it to Friday" moves
   the same event; "cancel it" deletes it; reminders arrive before the meeting. With Calendly:
   a single-use link in the reply, and after booking on it the booking confirmed within
   seconds.

Details to look at: whether `utm_content` added to a Calendly single-use link comes back in the
invitee's `tracking` (if not, every Calendly booking stays pending, logged `calendly.unmatched`,
and the team gets the "no meeting booked yet" alert); whether a rescheduled invitee keeps it;
how Graph returns all-day events in UTC; Google's 409 for a repeated event id and Graph's
`transactionId` (check 1 shows both); Calendly's 403 "already canceled".

### 33. Alerts, the emergency chain, takeover and follow-ups

1. Each transport with the app's own clients:

   ```
   pnpm --filter @repo/handoff live:alerts --phone +1<your mobile> --sms --call --whatsapp --email you@example.com
   ```

   **Pass:** a text, a call that reads the escalation message (and, with a public `<APP_URL>`,
   asks to press 1, then says "not acknowledged": the test has no real secret), a WhatsApp
   message from the agency number and an email.

2. An emergency end to end: put yourself first in a test business's
   `emergency.escalation_chain` (text message) and a colleague second, and write "I smell gas in
   the kitchen" in the test chat. **Pass:** the reply starts with the safety instructions; a
   text within seconds with a six-digit code and a link; after `emergency.acknowledge_minutes`
   a call ("press 1"); then the colleague's alert. Repeat and acknowledge each way: reply with
   the code (expect "Thank you. The emergency is acknowledged"), open the link (the page
   acknowledges nothing until its button is pressed), press 1 on the call. Each time the chain
   stops and the admin panel shows who acknowledged, how and when.

3. Delivery statuses: after check 2, the alerts of the texts and calls move to `delivered` (or
   `failed` with Twilio's error code).

4. A lead alert: qualify yourself in the test chat with `alerts.recipients` set to your phone
   and email. **Pass:** one alert per channel (not one per lead event) with the conversation
   link (sign-in required); with `alerts.hold_overnight` on, a qualified lead at night is
   alerted in the morning.

5. Takeover and follow-ups on WhatsApp (the test number of step 29): take over in the admin
   panel (or reply from the WhatsApp Business app) and check the bot stays silent, comes back
   after `handoff.auto_release_minutes` of silence, and that a customer who goes quiet gets the
   nudges of `follow_up.delays_minutes.whatsapp`, outside quiet hours, as the follow-up template
   once 24 hours have passed. Send "STOP": one confirmation, then nothing.

Details to look at: that Twilio signs voice callbacks over the URL without an explicit port and
status callbacks over the exact URL given; that a reply to an alert text arrives with `From` in
E.164; US carrier filtering of the alert texts; the WhatsApp alert template's approval; that
Twilio requests the `<Gather>` action URL with its query string intact ("The emergency is
acknowledged" after pressing 1 proves it). Twilio's requests carry no timestamp, so a captured
signed request can be replayed; what a replay can do is bounded in code (THREAT_MODEL 2.3).

### 34. CRMs and outgoing webhooks

For each CRM the pilot uses (secrets are read from standard input, never printed; `--write`
creates a test lead "HSRB Test Lead", test@example.com, then updates it: delete it afterwards):

```
pnpm --filter @repo/integrations live:check --provider hubspot --write
```

```
pnpm --filter @repo/integrations live:check --provider gohighlevel --location <location id> --write
```

```
pnpm --filter @repo/integrations live:check --provider jobber --write
```

```
pnpm --filter @repo/integrations live:check --provider housecall_pro --write
```

```
SERVICETITAN_APP_KEY=... pnpm --filter @repo/integrations live:check --provider servicetitan --tenant <id> --client-id <id> --booking-provider <id> --environment integration --write
```

```
pnpm --filter @repo/integrations live:check --provider webhook --url https://hooks.zapier.com/... --write
```

**Pass:** every line `ok`, including "recovery: found the first record (ok)" (the test lead is
pushed a second time as if the first answer had been lost). Then the full path once per CRM:
connect it in the business's Integrations page, set `integrations.sync_events`, finish a
qualifying conversation in the test chat, and see the record, its note and (GoHighLevel with a
pipeline) the opportunity appear; book a meeting and see the record updated. For webhook
receivers: add a target in the settings, reveal its signing secret as an agency admin and give
it to the receiver (Zapier and Make ignore it; your own system should verify it as
`docs/INTEGRATIONS.md` shows).

What the checks settle: GoHighLevel's `Version` value (if `v3` is refused use `2021-07-28`,
`GHL_API_VERSION`); **Jobber**, part of which was written from memory because its Developer
Center could not be read: the token endpoint and refresh-token rotation, and whether
`requestCreate` needs `customFormInput` in version 2025-04-16 (a developer fixes
`packages/integrations/src/connectors/jobber.ts` from the GraphiQL explorer if anything
differs); that Housecall Pro stores our `lead_source` as sent; that ServiceTitan's booking list
filters by `externalId`; whether HubSpot accepts the PKCE parameters. `docs/INTEGRATIONS.md`
lists, per vendor, what was read in the docs and what was written from memory.

### 35. Error reports, retention and backups

1. Sentry on a staging deployment (or `pnpm dev` with `SENTRY_DSN` set): sign in, then stop the
   database (on a developer computer `pnpm services:down`) and open the inbox. **Pass:** the
   request errors arrive in Sentry tagged with the route (`/inbox`), with no customer data,
   email address, phone number or token in them, and a database error reads "Failed query: …
   params: [removed]". The envelope format was written from Sentry's protocol as remembered,
   never sent to Sentry.
2. Retention: after the first night, the Inngest run of `retention-purge` lists what it deleted
   (counts only).
3. Backups and a test restore: follow `docs/BACKUP_RESTORE.md` once now, and record the date in
   `docs/RUNBOOK.md`.

### 36. Meta App Review

Follow `docs/META_APP_REVIEW.md`: it has the justification for each permission, the screencast
script and the instructions for Meta's reviewers. Submit only after checks 29 and 30 pass with
test users, since the screencast has to show them working. Without approval, only people with a
role on the app can use WhatsApp Embedded Signup and Facebook Login, and a person's reply on
Messenger or Instagram after 24 hours fails (the Human Agent feature).

## Part 6. Decisions to make before real customers

### 37. Legal and safety defaults, with your compliance adviser

These defaults were written without legal review. Read them with the agency's compliance
adviser (and lawyer where it applies) before the first real customer is answered; change them
agency-wide on the agency's Settings screen (`docs/SETTINGS.md` lists every default):

- `emergency.classes`: the safety instructions the bot gives word for word for gas, carbon
  monoxide, fire, electrical hazards, flooding, no heat, no cooling and structural damage.
- `persona.ai_disclosure` (default: the bot says it is an AI in its first message) and its
  wording. Some US states require bots to identify themselves.
- `follow_up.opt_out_keywords`, `follow_up.opt_out_confirmation` and `hours.quiet_hours`
  (default 21:00 to 08:00), which bear on TCPA and carrier rules for text messages.
- **`follow_up.opt_out_scope`.** An opt-out word (alone, or with "please", "now", "texting me"
  around it) is recorded and confirmed once. From then on nudges, reminders and check-ins never
  reach that customer, and an emergency always does (the safety instructions, the escalation
  chain and the emergency alerts). Everything else they write is decided by this setting:
  "all_automated" (the default) gives them no answer from the bot, and the team sees the message
  unread, gets an in-app warning and a "needs a person" alert; "proactive_only" lets the bot
  answer as usual. Choose the default with your adviser (TCPA, carrier and Meta rules for the
  channels you use), and check that `follow_up.opt_out_confirmation` ("You won't get any more
  messages from us") still says the truth for the scope you pick.
- `data.*`: how long conversations, photos and model records are kept.
- `emergency.escalation_chain` and `emergency.fallback_contacts` start **empty** (step 23):
  every business needs someone who can be texted or called.

### 38. Lead scoring defaults, and what the service radius cannot do

Read how the defaults sort leads (`docs/SETTINGS.md`, categories Qualification, Scoring and
Routing): the weights, the hot and warm thresholds (70 and 40), what each band leads to, and the
fit rules (out-of-area and unoffered services are turned away politely by default). Worked
examples are in `packages/leads/src/assess/leads.test.ts` (15 leads, three configurations,
every score explained). A **service radius** (`qualification.service_area.radius_miles`) cannot
be checked: the product has no ZIP-code geography. A lead whose location is not settled by the
listed ZIP codes, places or states is marked "location unverified" and never booked straight
into a meeting. List ZIP codes instead, or have a developer add a ZIP centroid table (for
example the US Census ZCTA gazetteer file) and a distance check in
`packages/leads/src/assess/service-area.ts`. With a key, the lead side of a real conversation
shows in the test chat's conversation in the inbox: the lead panel holds the score, the report
and the routing decision after every turn.

### 39. Limits and spend caps

Review the `limits.*` defaults (`docs/SETTINGS.md`): per customer 60 messages an hour, 100 bot
replies and $5 of model spend a day; per business 3,000 replies and $100 a day; 40 bot replies
per conversation (`conversation.max_bot_replies`); no monthly or agency-wide cap.
`limits.notice_message` is what a customer past a limit is told, at most once an hour; "If
anyone is in danger right now, call 911." is always part of it. A message that may describe an
emergency is still answered past a limit, 3 times per conversation and 100 times per business a
day. Know what a cap does and does not do (THREAT_MODEL 4.1, 4.1a, 4.15): it is approximate by
the turns already running when it is reached, and a flood on the website chat or by email that
reaches a business's daily cap stops that business's bot on every channel until the next day.
`limits.on_limit` = handoff puts a person on stopped conversations.

### 40. Evaluation thresholds and reply effort

After the first live runs of step 25, decide with a developer:

- the thresholds (`DEFAULT_THRESHOLDS` in `packages/evals/src/grade/rubric.ts`: pass at 4.0 of
  5, floors, allowed drops). They were set without any data. Run the following once to see how
  much a scenario's score moves between identical runs, and keep the allowed drops above that
  noise:

  ```
  pnpm eval --core --reps 3
  ```

- the reply effort: replies run at effort `medium` (DECISIONS 50). Compare with `high` by
  changing `model.reply.effort` in a profile of `packages/evals/src/scenarios/profiles.ts` for
  one run, and look at the score, the cost and "Time to write a reply" in the report;
- whether the simulated customers read like real ones; if they are too cooperative or too
  articulate, edit the persona briefs in `packages/evals/src/scenarios/personas.ts`.

### 41. Go live with the pilot business

When steps 1 to 40 are done: connect the pilot business's real channels (its WhatsApp number,
Facebook Page, Instagram account, inbox), publish the website chat snippet on its site, and
from then on
follow the daily checks of `docs/RUNBOOK.md`. Onboard further businesses with
`docs/ONBOARDING.md`.

## Local development

Not a launch step, a reminder: `cp .env.example .env.local`, set `LOCAL_AUTH_SECRET` and
`CREDENTIALS_ENCRYPTION_KEY` (`openssl rand -base64 48` and `openssl rand -base64 32`), then:

```
pnpm services:up && pnpm db:migrate && pnpm db:seed && pnpm dev
```

The seed prints the four demo users; their password is in `packages/db/src/seed/demo.ts`.
Without Inngest variables, jobs run inside the dev server process: sign in as the demo admin and
chat with a business at http://localhost:3000/dev/chat. Without `ANTHROPIC_API_KEY` the replies
come from a built-in rule-based stand-in, not from Claude (the page says so); set the key to
talk to the real bot, or `AI_MODEL_MODE=offline` to force the stand-in. Without the key a new
segment gets a built-in starter playbook (marked "starter") and the website reader takes facts
from structured data only. To use the real Inngest engine locally, start its dev server and set
`INNGEST_DEV=1` (and `INNGEST_BASE_URL=http://127.0.0.1:8288`) in `.env.local`:

```
npx inngest-cli@latest dev -u http://localhost:3000/api/inngest
```

or with Docker:

```
docker run --network host inngest/inngest inngest dev -u http://127.0.0.1:3000/api/inngest
```

The browser tests and the load test run without any account (the browser tests need a Chromium
for Playwright once per computer):

```
pnpm --filter @repo/web exec playwright install chromium
```


```
pnpm e2e -- --trace off
```

```
pnpm load:test
```

## What has never met the real service

Everything below is built against fakes, fixtures and documentation; the step named is where
it meets the real thing for the first time.

| Service                                    | What is unverified                                                                                                                                                                                                                                                      | Step       |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Claude API (replies)                       | That `claude-fable-5-2` accepts the request as built (ten strict tools, three cached system blocks, a system message after the customer's turn, server-side fallbacks with the beta header `server-side-fallback-2026-07-01`); cache reads; how the bot writes; photo analysis; the prices | 24, 25     |
| Claude API (web search, playbooks, facts)  | That `web_search_20260209` with `allowed_callers: ["direct"]` is accepted next to a strict tool; research step duration; citations; cache reads between steps; playbook quality; fact extraction                                                                          | 26         |
| Claude API (evaluation)                    | The judge's tool calls and quotes, the calibration faults, how real the simulated customers sound, cost, rate limits at six conversations at once                                                                                                                       | 25         |
| Supabase                                   | Roles, row-level security and grants on a real project; Auth (password, magic link); the Auth admin API's invitation (`/auth/v1/invite`) and sign-in link (`/auth/v1/otp`) with our email templates; Storage; Realtime for the inbox and the website chat                  | 17, 20, 23, 27, 28 |
| Inngest Cloud                              | Signed calls, the Vercel integration, production debounce timing                                                                                                                                                                                                         | 19, 22     |
| Meta                                       | WhatsApp, Messenger and Instagram payloads, sends, statuses, Embedded Signup, Facebook Login                                                                                                                                                                             | 29, 30, 36 |
| Google, Microsoft                          | Gmail and Graph mail, headers kept on send, push notifications, calendars                                                                                                                                                                                               | 31, 32     |
| Calendly, Twilio, alert SMTP, WhatsApp alerts | Webhooks, calls, texts, emails                                                                                                                                                                                                                                       | 32, 33     |
| CRMs                                       | HubSpot, GoHighLevel (including the look-ups after a lost answer), Jobber (partly from memory), Housecall Pro, ServiceTitan                                                                                                                                               | 34         |
| Sentry                                     | The envelope endpoint accepting our events; parsing a real project's DSN                                                                                                                                                                                                | 35         |
| Deepgram                                   | Voice transcription                                                                                                                                                                                                                                                     | 29         |
| GitHub Actions                             | The `verify` and `eval` workflows have never run on GitHub                                                                                                                                                                                                               | 3, 25      |

Other values chosen without a vendor lookup: the channel limits in `CHANNEL_CAPABILITIES`
(`packages/core/src/contracts/channel.ts`; WhatsApp's, Messenger's and Instagram's were checked
against Meta's docs on 2026-11-12, the website chat's and email's are ours to choose) and the US
area-code table behind `hours.customer_time_zone` = "phone_area_code" (numbers that moved keep
their old zone).
