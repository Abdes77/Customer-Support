# Runbook

How to run the reply bot once it is live: deploying a change, rolling it back, rotating keys,
reconnecting channels, the daily and weekly checks, and what to do when something goes wrong.
It is written for the agency's operator, who is not necessarily a developer; where a step needs
a developer it says so. The first launch is `docs/HUMAN_TODO.md`; backups and restores are
`docs/BACKUP_RESTORE.md`.

None of this has been carried out on a hosted deployment: there was none during the build. The
commands are the ones the launch checklist uses; treat the first time you run each as a check.

Where things are:

| What | Where |
| --- | --- |
| The app and its deployments | Vercel, the project of HUMAN_TODO step 9 |
| The database, sign-in users, stored files | Supabase, the project of step 5 |
| Background jobs (replies, sends, follow-ups, emergencies, sweepers) | Inngest dashboard (step 7) |
| Server errors | Sentry (step 8) |
| Problems the app noticed itself | Admin panel: the alerts in the inbox and on each business; `<APP_URL>/api/health/ready` |
| Everything a customer and the bot said | Admin panel, Inbox |
| Secrets | The vault of step 1 |

## Daily checks (about ten minutes)

1. **Readiness**, with the health token (replace `<HEALTH_CHECK_TOKEN>` with its value from
   the vault):

   ```
   curl -s -H "authorization: Bearer <HEALTH_CHECK_TOKEN>" <APP_URL>/api/health/ready
   ```

   Expect `"status":"ready"`. What each check means:

   | Check | When it fails or warns | What to do |
   | --- | --- | --- |
   | `database` | The database does not answer | Supabase status page and project health; nothing works until it is back |
   | `jobs` | Inngest keys are missing | Vercel variables (step 16), redeploy |
   | `model` | `ANTHROPIC_API_KEY` is missing | Vercel variables, redeploy |
   | `configuration` | A required variable is missing | The message names it |
   | `development_switches` | A developer-only switch is on in production | Remove `DEVELOPMENT_MODE`, `LOCAL_AUTH_SECRET`, any `DEV_*` variable and anything else the message names from Vercel, redeploy |
   | `unanswered` | Customer messages waited more than 30 minutes without any reply turn starting | "The bot is not answering" below |
   | `stuck_work` (warning) | A reply did not go out, or a message never reached the job runner, in the last day | The alerts in the admin panel name the conversations |
   | `emergency_contacts` (warning) | Active businesses whose emergencies reach nobody | Fill their escalation chain (business, Alert contacts) |
   | `error_reporting` (warning) | `SENTRY_DSN` is not set | Set it |

2. **Inngest dashboard:** no failed runs since yesterday; `pipeline-sweeper` ran in the last
   minutes. A failed `pipeline-reply` or `pipeline-send` run is also an alert in the admin
   panel.
3. **Sentry:** new issues since yesterday. Each event carries the business and message ids
   (never message text); trace one message with the command in "Investigating one message".
4. **Admin panel alerts:** critical ones first: an emergency nobody acknowledged, a reply that
   did not go out (`send_stuck`), a customer message that never reached the job runner
   (`ingest_stuck`), a business that reached a limit or spend cap (`limit_reached`), a
   connection that needs reconnecting, "emergencies reach nobody".
5. **Inbox:** unread conversations waiting on a person (takeovers, customers who opted out,
   conversations stopped by a limit with `limits.on_limit` = handoff).
6. **After every deployment, and once a day if nothing was deployed: the live round trip.** It
   proves the job runner really runs (readiness only notices a dead runner after half an
   hour, and only if customers write):

   ```
   APP_URL=<APP_URL> TEST_CHANNEL_SECRET=<the deployment's value> pnpm --filter @repo/pipeline live:roundtrip --business <the test business's id>
   ```

   Expect exactly one reply to the three test messages. Always name the agency's own test
   business (HUMAN_TODO step 22): without `--business` it writes into the first active
   business it finds, a client's.

Weekly: who has access (**People**, and the People tab of businesses with client logins) and the
audit log's `agency_membership.` and `business_membership.` entries; the database dump and the
file copy of `docs/BACKUP_RESTORE.md` ("Routine backups"); the
Claude API, Twilio and Inngest usage pages against the month's budget; `retention-purge` ran
every night (Inngest), with counts only.

## Deploying a change

1. The change arrives as a pull request. Its `verify` check must pass, and its `eval` check too
   when it touches the engine, the prompts, playbooks, knowledge, lead scoring or the settings
   registry (with the repository's `ANTHROPIC_API_KEY` secret this is a live evaluation against
   the saved baseline; HUMAN_TODO step 25). A developer also runs the browser tests and, for
   changes to the pipeline, the load test:

   ```
   pnpm e2e -- --trace off
   ```

   ```
   pnpm load:test
   ```

2. **If the pull request adds a database migration** (a new file in `packages/db/drizzle`),
   apply it to production **before** the code that needs it goes live, from the command
   computer with the production variables in `.env.local`:

   ```
   pnpm db:migrate
   ```

   ```
   pnpm db:doctor
   ```

   Migrations are written to be additive (new tables and columns), so the code still running
   keeps working. A migration that removes or renames something needs a developer's plan for
   the order of steps.

3. Merge the pull request into `main`. Vercel builds and deploys it, and the Inngest
   integration syncs the new functions. Without the Git integration:

   ```
   vercel deploy --prod
   ```

4. After the deployment: readiness (daily check 1) and the live round trip (daily check 6).

## Rolling back

- **The code:** Vercel, the project, Deployments, choose the last good deployment, "Promote to
  Production" (Vercel's instant rollback; `vercel rollback` does the same from the command
  computer). It takes effect in seconds. With the Inngest integration the functions of the
  promoted deployment are synced again; check the Inngest dashboard and run the live round trip.
- **The database is not rolled back with the code.** Applied migrations stay; that is safe as
  long as migrations are additive (step 2 above). Never edit or delete an applied migration
  file. If a migration itself was wrong, a developer writes a new migration that undoes it.
  Restoring a backup (`docs/BACKUP_RESTORE.md`) is the last resort: it loses everything written
  since the backup.
- **A setting** that made the bot misbehave: the Settings screen of the agency, segment or
  business shows where each value comes from; "Reset" returns it to the inherited value. Every
  change is in the audit log (agency admins, Audit).
- **A playbook:** Playbooks, the segment, Versions, roll back to an earlier version.
- **Stop the bot at once** for one business: pause the business on its page (every turn stops;
  messages are still stored and visible in the inbox). For one conversation: take it over in
  the inbox. Emergencies only: `emergency.enabled` off stops the paging while the safety
  instructions still go out.

## Rotating keys

Rotate a key at once when it may have leaked (a laptop lost, a person who knew it left), and
otherwise on the agency's schedule. After each rotation: readiness, the live round trip, and
the vault updated.

### The credential encryption key (`CREDENTIALS_ENCRYPTION_KEY`)

It encrypts every stored channel, calendar and CRM credential. Losing it means reconnecting
everything; rotating it needs care.

1. Generate a new key (`openssl rand -base64 32`) and choose a new id, for example `k2`.
2. In Vercel (and `.env.local`): `CREDENTIALS_ENCRYPTION_KEY` = the new key,
   `CREDENTIALS_ENCRYPTION_KEY_ID` = `k2`, and `CREDENTIALS_ENCRYPTION_OLD_KEYS` =
   `k1:<the old key>` (the old id is `k1` when the id was never set). Redeploy.
3. Check: `pnpm db:doctor`, last line "Credential encryption key" says ok.
4. Old credentials keep working: they are decrypted with the old key and encrypted with the new
   one the next time they are written. OAuth tokens are rewritten at their next refresh (within
   hours); page tokens, IMAP and SMTP passwords and CRM API keys only when they are connected
   again. **There is no command that re-encrypts everything at once** (THREAT_MODEL 4.9), so
   keep the old key in `CREDENTIALS_ENCRYPTION_OLD_KEYS` until every connection has been
   connected again; if the old key leaked, reconnect every connection now (the connection
   pages show each one) and only then remove it.
5. Store the new key and its id in the vault, and keep the old one there until it is removed
   from `CREDENTIALS_ENCRYPTION_OLD_KEYS`.

### The other secrets

| Secret | How to rotate it | What happens meanwhile |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Create a new key in the Claude Console, set it, redeploy, then delete the old key | Nothing, if done in this order |
| `INNGEST_SIGNING_KEY` | Put the old key in `INNGEST_SIGNING_KEY_FALLBACK`, the new one in `INNGEST_SIGNING_KEY`, redeploy, rotate in Inngest, then remove the fallback (the Vercel integration may do this for you) | Nothing |
| `INNGEST_EVENT_KEY` | Create a new event key in Inngest, set it, redeploy, delete the old key | Nothing |
| `META_APP_SECRET` | Reset it in the Meta app (App settings, Basic), set it at once, redeploy | Webhooks signed with the new secret are refused until the deployment has it; Meta retries them |
| `META_WEBHOOK_VERIFY_TOKEN` | Set the new value, redeploy, then enter it in the three webhook configurations | Only Meta's verification of the URL needs it |
| `TWILIO_AUTH_TOKEN` | Twilio's console: create a secondary token, promote it, set it, redeploy | Twilio's callbacks are refused between the promotion and the deployment (an acknowledgement by text may then need repeating) |
| `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_SECRET`, `CALENDLY_CLIENT_SECRET`, CRM client secrets | Add a second secret at the provider, set it, redeploy, delete the old one | Nothing |
| `MICROSOFT_GRAPH_CLIENT_STATE` | Avoid unless it leaked: set the new value and redeploy | Outlook notifications carrying the old value are refused until each subscription is renewed by `email-watch-renew`; not tried live |
| `CALENDLY_WEBHOOK_SIGNING_KEY` | Re-issued by Calendly support | Calendly bookings are not recorded until it is set |
| `WIDGET_SESSION_SECRET` | Set a new value, redeploy | Every website visitor starts a new chat |
| `TEST_CHANNEL_SECRET` | Set a new value, redeploy | The test chat reconnects |
| `HEALTH_CHECK_TOKEN` | Set a new value, redeploy, update the uptime monitor | The monitor sees only "ready" or "not_ready" |
| `SUPABASE_SERVICE_ROLE_KEY`, anon key, JWT secret | Supabase, Project Settings, API (new API keys or a JWT secret rotation); set them, redeploy | A JWT secret rotation signs everyone out. The service-role key also sends the People screens' invitations: after rotating, add someone and check the email arrives |
| Database password | Supabase, Database settings, reset; update both connection strings, redeploy | The app cannot reach the database between the reset and the deployment |
| A business's own credentials (page token, IMAP password, CRM key) | Reconnect on the business's connection page | That channel or CRM stops until reconnected |

## Reconnecting a channel, calendar or CRM

Each business's Channels and Integrations pages show every connection as connected, "needs
reconnecting" (the provider took access away: a password changed, the app was removed, a token
was revoked) or in error, with the provider's reason. Reconnect as an agency member (client
users cannot open these pages):

- **WhatsApp:** "Connect with Facebook" again (Embedded Signup) with the client's Meta admin.
  After a ban or a quality warning, WhatsApp Manager says why.
- **Messenger and Instagram:** "Connect with Facebook" again (Facebook Login), choosing the same
  Page. Check in Meta Business Suite that no other app became the Page's messaging app.
- **Gmail and Microsoft 365:** "Connect Gmail" / "Connect Microsoft 365" again with the inbox's
  owner. While Google has not verified the app, connections of test users may need this more
  often.
- **IMAP/SMTP:** the IMAP form again with the new password (an app password where the provider
  requires one).
- **Calendars and Calendly:** the connect button on the Integrations page, or a new Calendly
  personal token.
- **CRMs:** the connect button (OAuth) or a new API key. Leads that could not be delivered
  meanwhile are retried by the integrations sweeper; the errors are on the Integrations page.

After reconnecting, send a test message on that channel (or qualify yourself in the test chat
for a calendar or CRM) and check the reply or the record.

## When something goes wrong

### The bot is not answering

Readiness shows `unanswered` failing, or the inbox fills with unread conversations and no bot
replies. (A turn that started and failed does not make `unanswered` fail: it raises its own
alert and appears as a failed `pipeline-reply` run.)

1. Readiness: is `database`, `jobs` or `model` failing? Fix that first.
2. Inngest dashboard: is the app synced, and do `pipeline-reply` runs appear? If not: sync again
   (`curl -X PUT <APP_URL>/api/inngest`), check `INNGEST_SIGNING_KEY` and `APP_URL`, and that
   the deployment is on a plan with 300-second functions.
3. Runs that fail: open one; the error says why (a refused API key, a provider error). Sentry
   has the same.
4. Run the live round trip. When it passes again, customers whose messages waited are answered
   by Inngest's retries if their events were accepted; open the unread conversations in the
   inbox and answer by hand (take over) any that still wait.

### A reply did not go out

The alert names the conversation. The message shows as failed with the provider's reason:
a closed messaging window on WhatsApp (needs an approved template, step 29 of the checklist), a
disconnected channel (reconnect it), a rate limit (it was retried). Take the conversation over
and answer by hand if the customer is still waiting.

### An emergency

The escalation chain texts, then calls the business's contacts in order until someone
acknowledges. If an emergency alert reaches the agency: call the business's contacts yourself,
then acknowledge it in the admin panel (the conversation's emergency panel). If emergencies
reach nobody, fill the business's escalation chain at once.

### A flood of messages, or a spend cap reached

The `limit_reached` alert says which limit. Customers past a limit get the notice (with the
sentence about calling 911) and an emergency is still answered. A business-wide daily cap stops
that business's bot on every channel until the next day (THREAT_MODEL 4.15). Options: raise the
cap for the day (Settings, Limits), switch the website chat off for the day if the flood comes
from there, set `limits.on_limit` = handoff so a person takes the stopped conversations, or
pause the business. Many made-up emergencies page the on-call people (THREAT_MODEL 4.1b): pause
the business or switch `emergency.enabled` off (safety instructions still go out), and check the
Twilio spend limit.

### Investigating one message

From an alert, a log line or a Sentry event (tags `businessId`, `messageId`), or the inbox
address of the conversation:

```
pnpm --filter @repo/pipeline trace <business id> <message id>
```

It prints the turn that answered the message, its model calls (tokens, cost, time), its actions
and the replies with their delivery status: ids and numbers, never message text.

### Someone leaves, or a login may be misused

On **People** (agency staff) or the business's **People** tab (client logins), "Remove" and
"Confirm removal". The person's next request is turned away, whatever their session; nothing
else needs to happen for the app. If the account itself may be compromised (a stolen password),
also delete or ban the user in Supabase, Authentication, Users, which ends their sessions with
Supabase too. The audit log (action `agency_membership.` or `business_membership.`) shows who
gave and took access, and when. An agency always keeps one agency admin: to remove the last
one, make someone else admin first. If no admin can sign in at all, run
`pnpm db:create-admin` from the command computer (`docs/HUMAN_TODO.md` step 20).

Invitations do not arrive: Supabase, Authentication, Logs; the usual causes are the built-in
email sender's hourly limit and an email template whose link does not go to `/auth/confirm`
(HUMAN_TODO step 5.4). "You have added 20 people in the last 24 hours" is the app's own limit
per person; another admin can continue.

### A customer asks for their data to be deleted

Conversations, photos and model records are deleted automatically after the periods of the
`data.*` settings (`retention-purge`, nightly). For an individual request before then, a
developer deletes that contact's conversations (the retention code does the same per
conversation, `purgeConversationIfDue` in `packages/pipeline/src/retention`); there is no
screen for it yet.

## Restore test log

Restore the latest backup into a scratch project twice a year (`docs/BACKUP_RESTORE.md`, "Test
the restore") and record it here.

| Date | Backup restored | `db:doctor` | Conversation with a photo opened | By |
| --- | --- | --- | --- | --- |
| | | | | |
