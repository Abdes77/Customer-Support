# Backup and restore

Written by C17. What holds state, how it is backed up, and how to restore it without breaking
tenant isolation or losing access to stored credentials. Nothing here was run against a
hosted project (there is none in the build); the commands are for the agency's operator.

## What holds state

| Store | What is in it | Backed up by |
| --- | --- | --- |
| PostgreSQL (Supabase) | Everything: tenants, conversations, messages, leads, settings, playbooks, the audit log, encrypted tenant credentials, job bookkeeping (`dead_letters`, `alerts`, `usage_counters`) | Supabase's daily backups (Pro plan: 7 days; point-in-time recovery as an add-on) plus the logical dump below |
| Supabase Storage, bucket `attachments` | Customers' photos and files, under `{agency}/{business}/...` | Not included in Supabase's database backups: copy the bucket (below) |
| `CREDENTIALS_ENCRYPTION_KEY` (and `CREDENTIALS_ENCRYPTION_OLD_KEYS`) | The key every stored credential is encrypted with | The agency's password manager. **Without it a restored database has no usable credentials**: every channel, calendar and CRM must be connected again |
| Inngest | Runs in flight (sleeping follow-ups, emergency chains, reminders) | Not backed up. The sweepers rebuild what matters from PostgreSQL (`pipeline-sweeper`, `handoff-sweep`, `scheduling-reminder-sweep`, `integrations-sweep`) |
| Environment variables (Vercel) | Platform secrets and configuration | The password manager; `.env.example` lists every name |

## Routine backups

1. Keep Supabase's scheduled backups on (Project settings, Database, Backups). Turn on
   point-in-time recovery for production if the agency can afford it: it narrows the loss to
   minutes.
2. Weekly, from a trusted machine with the **direct** connection string (`DATABASE_URL_DIRECT`):

   ```
   pg_dump --format=custom --no-owner --no-privileges \
     --file=hsrb-$(date +%F).dump "$DATABASE_URL_DIRECT"
   ```

   The dump contains customer personal data and encrypted credentials: store it encrypted
   (for example `age -r <recipient> hsrb-….dump > hsrb-….dump.age`), in a different account
   than the database, and delete copies older than the longest retention the agency promises
   (`data.conversation_retention_days`).
3. Weekly, the storage bucket (Supabase's S3-compatible endpoint, Project settings, Storage):

   ```
   aws s3 sync s3://attachments ./attachments-$(date +%F) \
     --endpoint-url https://<project>.supabase.co/storage/v1/s3
   ```

4. Once, and after every rotation: check that the password manager holds the current
   `CREDENTIALS_ENCRYPTION_KEY` with its id (`CREDENTIALS_ENCRYPTION_KEY_ID`).

## Restore

Restore into a **new** Supabase project (or the same one after a failed migration), never on
top of a live database.

1. Create the project as in `docs/HUMAN_TODO.md` entry 3 (private bucket `attachments`).
2. Restore the schema and data:

   ```
   pg_restore --no-owner --no-privileges --dbname="$NEW_DATABASE_URL_DIRECT" hsrb-….dump
   ```

3. Re-create the roles and privileges the dump does not carry, then check them:

   ```
   DATABASE_URL_DIRECT=<new> pnpm db:migrate   # applies nothing new; re-runs the privilege sync
   DATABASE_URL=<new pooler> pnpm db:doctor    # every line must say ok
   ```

   `db:doctor` checks the roles `authenticated` and `app_system`, forced row-level security
   on every table, privileges that match the policies, the applied migrations and that the
   configured encryption key decrypts a stored credential.
4. Copy the files back into the new bucket (`aws s3 sync ./attachments-… s3://attachments …`).
5. Set the same `CREDENTIALS_ENCRYPTION_KEY` (and old keys) on the deployment. With a
   different key, `db:doctor`'s last line fails and every connection page shows "connect it
   again".
6. Point the deployment at the new project (Supabase variables, `DATABASE_URL`,
   `DATABASE_URL_DIRECT`), deploy, and open `/api/health/ready` with the health token: it must
   answer `ready` (database, jobs, model, no development switch).
7. Webhook subscriptions stay valid (they point at `APP_URL`); Gmail watches and Graph
   subscriptions are renewed by `email-watch-renew` within the hour. Messages that providers
   delivered while the app was down are retried by the providers (Meta for about a day); the
   email poll reads mailboxes from their stored cursors.

## What a restore loses, and how it heals

- Messages stored after the backup: the providers' retries bring back webhook deliveries made
  in their retry window; email is read again from the cursors in the restored rows (the
  Message-ID makes duplicates harmless).
- Runs that were sleeping in Inngest: follow-ups, emergency chains, takeover releases and
  reminders are resumed by `handoff-sweep` (every five minutes) and
  `scheduling-reminder-sweep` (hourly) from their rows.
- Files deleted by retention after the backup come back with the bucket copy; the next
  `retention-purge` deletes them again.

## Test the restore

Twice a year, restore the latest dump into a scratch project and run `pnpm db:doctor` against
it, then open one conversation with a photo in the admin panel of a preview deployment pointed
at it. Record the date in the runbook (C18).
