# Home-services reply bot

Multi-tenant bot that replies to customer messages for US home-services businesses, qualifies
leads and hands them off. TypeScript monorepo: pnpm, Turborepo, Next.js (App Router), Supabase
with Drizzle, Inngest, the Anthropic SDK, Zod, Vitest, Playwright, Tailwind.

## Read first

- `docs/SPEC.md`: what the product is.
- `docs/ARCHITECTURE.md`: components, webhook-to-reply flow, tenancy and security, jobs,
  Claude API rules, package layers, contracts between chunks.
- `docs/BUILD_PLAN.md`: which paths each chunk owns and how to change shared files.
- `docs/SETTINGS.md`: every setting, how values resolve, how to read, change and add one.
- `docs/DECISIONS.md`, `docs/HUMAN_TODO.md` (the numbered launch checklist: renumber references when adding a step), `docs/INTEGRATIONS.md` (CRMs), `docs/THREAT_MODEL.md`, `docs/BACKUP_RESTORE.md`, `docs/RUNBOOK.md`, `docs/ONBOARDING.md`, `docs/META_APP_REVIEW.md`, `docs/BUILD_REPORT.md`.
- `AUTOBUILD.md`: the build rules. Never edit it or `autobuild/STATE.md`.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm install` / `pnpm verify` | Install everything / the gate: typecheck, lint (ESLint, package boundaries, Prettier check), tests |
| `pnpm eval` (`--help`, `--core`, `--mode mock`) | The evaluation suite (ARCHITECTURE "As built (C7)"): live with `ANTHROPIC_API_KEY`, stand-ins without. A change to `packages/ai`, prompts, playbooks or default settings must pass it (HUMAN_TODO 25) |
| `pnpm typecheck` / `pnpm lint` / `pnpm test`; `pnpm --filter @repo/<name> test` | One part of verify; the tests of one package (also `typecheck`, `lint`) |
| `pnpm format` / `pnpm check:boundaries` | Fix formatting with Prettier / check package dependencies against `tooling/boundaries.mjs` |
| `pnpm env:example` / `pnpm settings:docs` | Regenerate `.env.example` (from `packages/core/src/env/spec.ts`) / `docs/SETTINGS.md` (from the registry) |
| `pnpm services:up` | Start local PostgreSQL 16, create `hsrb_dev` and `hsrb_test` |
| `pnpm db:migrate` / `db:seed` / `db:reset` / `db:generate` | Apply migrations (the only supported way); load demo data; wipe a local database; write a migration after changing `packages/db/src/schema` |
| `pnpm db:doctor` / `pnpm db:create-admin --slug <agency> --email <user>` / `pnpm --filter @repo/pipeline trace <business> <message>` | Check a database (roles, migrations, RLS, privileges, encryption key) / make a user agency_admin (first-time setup) / one customer message's trace: turn, model calls, actions, sends |
| `pnpm dev` | Run the Next.js app at http://localhost:3000 (jobs in-process without Inngest, offline model without a key; test chat at `/dev/chat`; readiness at `/api/health/ready`). A production build is production unless `DEVELOPMENT_MODE=1` |
| `pnpm e2e -- --trace off` / `pnpm load:test` / `pnpm --filter @repo/widget-embed build` | Playwright in `apps/web/e2e` against a production build on a fresh database, with fakes of Meta and a mail server (needs `services:up`, ports 3100 and 3101 free, no other `next build` at the same time) / 50 businesses' bursts through the pipeline on local PostgreSQL (`src/load` in `packages/pipeline`) / rebuild the website chat script after editing `packages/widget-embed/src/browser` |
| `pnpm --filter @repo/pipeline live:roundtrip` / `@repo/channel-whatsapp live:check` / `@repo/channel-messenger-instagram live:check` / `@repo/channel-email live:check` / `@repo/scheduling live:check` / `@repo/handoff live:alerts` / `@repo/integrations live:check --provider <crm|webhook>` | Live webhook → jobs → reply check against a running app (HUMAN_TODO 22) / WhatsApp Cloud API check with Meta's test number (HUMAN_TODO 29) / Messenger and Instagram check with a test Page (HUMAN_TODO 30) / IMAP/SMTP inbox check (HUMAN_TODO 31) / Google, Outlook or Calendly account check (HUMAN_TODO 32) / a test alert by text, call, WhatsApp and email (HUMAN_TODO 33) / a CRM account or webhook receiver (HUMAN_TODO 34) |
| `pnpm --filter @repo/ai live:conversations` / `prompt:fingerprint --print` | Scripted customers against the Claude API (needs a key, HUMAN_TODO 24) / show the prompt as the model gets it |
| `pnpm --filter @repo/knowledge live:playbook` / `live:crawl <url>` / `api-key --slug <agency> --name <name>` | Generate playbooks with the Claude API and web search (HUMAN_TODO 26) / read a website through the guarded fetcher / create an import API key |

## Layout

- `apps/web`: every HTTP route and screen. Thin: validate, authorize, call a package.
- `packages/core`: contracts, events, ids, errors, logger, env spec. No workspace imports.
- `packages/<domain>`: db, jobs, settings, ai, knowledge, leads, pipeline, scheduling, handoff, integrations, evals, observability, widget-embed, `channels/*`.
- `tooling/boundaries.mjs`: which package may import which. Enforced by `pnpm verify`.

## Conventions

- Import packages by entry point (`@repo/core`), never by a path into `src`. Inside a
  package use relative imports. Packages export TypeScript source; there is no build step.
- Strict TypeScript, no `any`, no floating promises. Run `pnpm format` before finishing.
- Validate every boundary with Zod: webhooks, API bodies, tool inputs, job payloads, env.
- Tenant safety: reach the database only through `getDatabase()` from `@repo/db`:
  `.asUser(user).run(...)` for a signed-in user, `.forBusiness(id).run(...)` /
  `.forAgency(id).run(...)` for jobs and webhooks. PostgreSQL confines both; there is no
  unrestricted client. Spread `ctx.tenant` into inserts; use the branded ids.
- New table: policies in the schema, `pnpm db:generate`, an entry in
  `packages/db/src/testing/isolation-matrix.ts` (ARCHITECTURE §8). Tests that need a database
  use `createTestDatabase()` from `@repo/db/testing`.
- Auth in `apps/web`: `requireAccess()`, then `requireBusinessRole()`; admin pages and actions:
  `requireBusinessPage` / `runAction` (`@/server/admin`). Local sign-in: `LOCAL_AUTH_SECRET`.
- Configuration: declare variables in the env spec and read them with `getEnv()` /
  `requireEnv()` from `@repo/core/env`. `process.env` is blocked by ESLint.
- Settings: anything a business might tune is a setting, not an env variable or a constant.
  Declare it in `packages/settings/src/registry`, read it from the turn's snapshot
  (`settings.values["category.name"]`), change stored values only through the store.
- Secrets: never print, log or commit one. Tenant credentials are encrypted before storage and
  never sent to the browser or put in a job payload.
- Logging: `logger.child({ traceId, businessId })` from `@repo/core`. Never log message text,
  contact details or tokens, nor build an error message from a statement's values or a customer's
  words (errors reach logs, Sentry, Inngest, stored rows; see `safeErrorMessage` in `@repo/core`).
- Jobs: `JobDefinition`s from `@repo/jobs` (ARCHITECTURE §4), registered in
  `apps/web/src/server/pipeline`; payloads carry ids only; handlers are idempotent; side
  effects sit in their own step. Pipeline tests: `src/testing/harness.ts` in `packages/pipeline`.
- Model calls go through `callModel` in `packages/ai` (ARCHITECTURE §5: no `thinking`,
  `temperature` or forced `tool_choice`; check `stop_reason`; keep the cached prefix stable).
  A prompt change needs a new version: the tests in `packages/ai/src/prompt` say which.
- Playbooks and facts only through `@repo/knowledge` (stored versions are immutable); fetch a
  user's URL only with its `createSafeFetcher` (SSRF guard).
- Tests sit next to the source as `*.test.ts`. Vendor calls use fixtures and an injected `fetch`,
  the model `createScriptedModelClient` from `@repo/ai/testing`; anything needing a real account
  goes to `docs/HUMAN_TODO.md` with the command for the live check. One version per dependency,
  in the `catalog:` of `pnpm-workspace.yaml`.
- Ambiguity: choose the most reasonable option and add one line to `docs/DECISIONS.md`.
