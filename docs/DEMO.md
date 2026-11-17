# The demo site

A public website that shows the assistant at work: a visitor picks a trade, lands on a sample
business's website, chats with its assistant the way a customer would, and watches the lead
being scored next to the chat. It is the real system: the same website chat, pipeline, engine,
settings, lead scoring and report every client business gets. Only the businesses are samples.

WhatsApp, Instagram, Messenger, email, calendars, alerts and CRMs are not part of it; they are
set up later with `docs/HUMAN_TODO.md`.

## What is in it

- **`/demo`**: the front page, with one card per listed business. A visitor who is not signed
  in and opens the site's address (`/`) is sent here; someone signed in goes to the admin panel.
- **`/demo/<business>`**: the business's "website", drawn from its profile and its knowledge
  (services, service area, hours, licenses, warranties, financing, reviews), with its real chat
  in the corner, sample questions that start a conversation with one click, and the panel
  **What the business sees**: the score, each answer with the customer's own words, what the
  assistant is still finding out, the next step (book, call back, polite no) and the written
  report. "Start over as a new customer" begins a fresh conversation.
- **Five sample businesses**, stored by `pnpm demo:setup`: Ironwood Roofing (Lakewood, CO),
  Northlake Heating & Air (Minneapolis, MN), Tidewell Plumbing (Tampa, FL), Brightwire Electric
  (Austin, TX) and Maple & Stone Remodeling (Columbus, OH). They are invented (555 phone numbers,
  `.example` addresses) and the pages say so. Their content is in
  `apps/web/src/server/demo/sample-businesses.ts`.
- **One setting decides who is listed**: "Public demo page" (`channels.widget.demo_page`, under
  Channels, Website chat, per business, off by default). Any business with its website chat
  connected can be put on the demo site with it, a prospect's own business included (see
  "A prospect's own business" below).

Every demo conversation is an ordinary conversation of that business: it appears in the inbox
and the lead list of the admin panel, with the same score and report the visitor saw.

## See it on this computer

With Node.js 22, pnpm 10 and PostgreSQL 16 (or Docker), from the repository folder. Create
`.env.local` from `.env.example` first and fill in `LOCAL_AUTH_SECRET` and
`CREDENTIALS_ENCRYPTION_KEY` as "Local development" at the end of `docs/HUMAN_TODO.md` says.

```
pnpm install
```

```
pnpm services:up
```

```
pnpm db:migrate
```

```
pnpm demo:setup
```

```
pnpm dev
```

Then open http://localhost:3000/demo. With `ANTHROPIC_API_KEY` in `.env.local` the replies come
from Claude; without it a built-in rule-based stand-in answers, which shows the mechanics (the
chat, the panel, the report) but not how the assistant really writes.

`pnpm demo:setup` puts the samples in an agency called "Demo agency" (slug `demo`). To keep
them next to your clients instead, name your agency: `pnpm demo:setup --slug your-agency`. It is
safe to run again: it updates what it wrote and keeps facts and settings a person changed.

## Put it online

What is needed, and nothing else: a database, a job runner, hosting and a Claude API key. The
steps below are the short path through `docs/HUMAN_TODO.md` (its step numbers are given for
the details); everything else in that checklist can wait.

1. **Claude API key** (HUMAN_TODO 4): https://platform.claude.com, Settings, API keys. The
   workspace needs 30-day data retention for the default reply model, `claude-fable-5-2`.
2. **Supabase project** (HUMAN_TODO 5): https://supabase.com/dashboard, New project. Copy the
   Project URL, the anon key, the service_role key, the JWT secret, the Transaction pooler
   connection string (port 6543) and the Session pooler or Direct connection string (port 5432).
   Create a private Storage bucket named `attachments` (photos sent in the chat go there).
3. **Vercel project** (HUMAN_TODO 9): https://vercel.com, Add New, Project, import this
   repository. Root Directory `apps/web`, framework Next.js, Node.js 22.x; leave the commands
   alone (the repository's `apps/web/vercel.json` sets the build command). Note the address
   Vercel gives the project (Settings, Domains), for example `https://your-demo.vercel.app`.
4. **Inngest** (HUMAN_TODO 7): in the Vercel project, Integrations, add **Inngest** from the
   Marketplace and connect it to this project. It sets `INNGEST_EVENT_KEY` and
   `INNGEST_SIGNING_KEY` and registers the app's jobs on every deployment. Without it the chat
   stores messages and never answers.
5. **Two secrets of the app's own** (HUMAN_TODO 6). Run each once in a terminal and keep the
   results in your password manager:

   ```
   openssl rand -base64 32
   ```

   for `CREDENTIALS_ENCRYPTION_KEY`, and

   ```
   openssl rand -base64 48
   ```

   for `WIDGET_SESSION_SECRET`.
6. **Variables**: Vercel, the project, Settings, Environment Variables, for **Production**:

   | Variable | Value |
   | --- | --- |
   | `APP_URL`, `NEXT_PUBLIC_APP_URL` | the project's address from step 3, both the same |
   | `DATABASE_URL` | the Transaction pooler string (port 6543) |
   | `DATABASE_URL_DIRECT` | the Session pooler or Direct string (port 5432) |
   | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET` | from step 2 |
   | `CREDENTIALS_ENCRYPTION_KEY`, `WIDGET_SESSION_SECRET` | from step 5 |
   | `ANTHROPIC_API_KEY` | from step 1 |
   | `DEPLOY_MIGRATE` | `1` |
   | `DEPLOY_DEMO_AGENCY` | your agency's name as the demo site should show it |

   The last two make the build do the database work: with `DEPLOY_MIGRATE=1` every deployment
   first applies pending migrations (`pnpm db:migrate`), and with `DEPLOY_DEMO_AGENCY` it then
   stores the sample businesses in that agency, creating it when it is new (`pnpm demo:setup`).
   Both are safe to repeat and a failure stops the deployment before anything is published.
   Without them, run the two commands from a computer as HUMAN_TODO 17 describes.
7. **Deploy**: Vercel, Deployments, Redeploy (or push to the branch Vercel deploys). The build
   log shows the migrations and the five sample businesses. Then open `<APP_URL>/demo`.

**Pass:** the front page lists the five businesses; on a business's page the chat answers
within seconds, and the panel next to it fills in. In Inngest's dashboard the app shows its
functions, `pipeline-reply` and `pipeline-send` among them, and a run for each reply.

If the chat stays silent: Inngest is not connected (step 4; Inngest dashboard, Apps) or the
Claude API refused the key or the model (Vercel, Logs; a 400 that mentions data retention is
step 1). If the chat does not appear at all: `APP_URL` is not the address in the browser's
address bar (the chat on the demo pages works on the app's own address only). The checks of
HUMAN_TODO 21 apply to this deployment as to any other.

**The admin panel** (to read the demo conversations as the business would): in Supabase,
Authentication, Users, add yourself with a password ("Auto Confirm User"), then on a computer
with the repository and the production `DATABASE_URL` in `.env.local` (HUMAN_TODO 20):

```
pnpm db:create-admin --slug <the agency's slug the build log printed> --email you@example.com
```

## Before showing it to anyone

Nothing has replaced this step: read real conversations first. The assistant's prompt was
written without ever being read by the model. Two ways to see how it really writes:

- On GitHub (no computer needed): add the repository secret `ANTHROPIC_API_KEY` (Settings,
  Secrets and variables, Actions), then change the first line of `.github/live-check.request`
  from `none` to `all` and push. The workflow `live-check` plays nine scripted customers
  against the Claude API and prints every transcript; it costs a few dollars.
- On a computer with the key in `.env.local`: `pnpm --filter @repo/ai live:conversations`
  (HUMAN_TODO 24), then the evaluation suite (HUMAN_TODO 25).

Then chat with each sample business yourself: a good lead, a price shopper, someone outside
the service area, a real emergency ("I smell gas"), someone rude, someone who tries to make the
assistant ignore its instructions.

## What the demo does and does not show

- **Shown as it is:** the replies, the qualification questions, the score, the report, the
  routing decision, emergencies (safety steps first), the business's rules on prices, the
  after-hours behaviour, photos (the assistant looks at them).
- **Not connected in the demo:** no calendar, so a lead who would be booked is told the team
  will be in touch (the panel still says "Hot leads: book a meeting"); no alert reaches a
  phone; no follow-up nudges (switched off for the samples).
- **Starter playbooks:** the trades get the engine's built-in playbook (complete, no price
  ranges, not researched). For one the model researches on the web, open the trade under
  Playbooks in the admin panel and choose "Generate again" (a few dollars per trade).
- **Speed:** a reply takes as long as the model takes at the "Replies: effort" setting
  (`model.reply.effort`, default medium) plus one second of wait. If replies feel slow in a
  live demo, lower the effort for the sample businesses or their trades.

## A prospect's own business

The strongest demo is the prospect's own company. Onboard it in the admin panel as a business
(`docs/ONBOARDING.md`): profile, trade, and its facts from your lead-generation data or its
website. On its Channels page connect the website chat; in its Settings, under Channels, switch
on **Public demo page**. It then has a page at `/demo/<its address in the business list>` and a
card on the front page. Switch the setting off to take it down. While it is on, anyone with the
link can chat with it and see the lead of their own conversation, so use it for a business that
knows about it.

## Cost and abuse

The demo is a public page that spends money on the Claude API when someone chats. The sample
businesses are stored with low caps, all ordinary settings that can be changed per business:
at most $2 of model cost per visitor a day and $20 per business a day
(`limits.contact_daily_spend_usd`, `limits.business_daily_spend_usd`), 600 replies per business
a day, and the website chat's own limits per visitor and per address. A visitor past a cap gets
a short notice instead of a reply; an emergency is still answered. Add a firewall rate limit on
`/api/widget/v1` in Vercel (HUMAN_TODO 21, item 5) before sharing the link widely.

To take the demo offline: switch "Public demo page" off for each sample business, or pause
them on their pages in the admin panel.
