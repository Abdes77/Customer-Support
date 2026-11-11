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

## Accounts the build will ask for

No action yet. Each row becomes a full entry above when its chunk is built; the variables are
already listed and described in `.env.example`.

| Account | Needed for | Variables (group in `.env.example`) | Entry added by |
| --- | --- | --- | --- |
| Supabase project (production) | Database, auth, storage, realtime | Supabase and PostgreSQL | C1 |
| Encryption key | Stored channel and integration credentials | `CREDENTIALS_ENCRYPTION_KEY` (`openssl rand -base64 32`) | C1 |
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
