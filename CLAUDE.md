# Home-services reply bot

Multi-tenant bot that replies to customer messages for US home-services businesses, qualifies
leads and hands them off. TypeScript monorepo: pnpm, Turborepo, Next.js (App Router), Supabase
with Drizzle, Inngest, the Anthropic SDK, Zod, Vitest, Playwright, Tailwind.

## Read first

- `docs/SPEC.md`: what the product is.
- `docs/ARCHITECTURE.md`: components, webhook-to-reply flow, tenancy and security, jobs,
  Claude API rules, package layers, contracts between chunks.
- `docs/BUILD_PLAN.md`: which paths each chunk owns and how to change shared files.
- `docs/SETTINGS.md` (once it exists), `docs/DECISIONS.md`, `docs/HUMAN_TODO.md`.
- `AUTOBUILD.md`: the build rules. Never edit it or `autobuild/STATE.md`.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm install` | Install everything |
| `pnpm verify` | The gate: typecheck, lint (ESLint, package boundaries, Prettier check), tests |
| `pnpm typecheck` / `pnpm lint` / `pnpm test` | One part of verify |
| `pnpm --filter @repo/<name> test` | Tests of one package (also `typecheck`, `lint`) |
| `pnpm format` | Fix formatting with Prettier |
| `pnpm check:boundaries` | Check package dependencies against `tooling/boundaries.mjs` |
| `pnpm env:example` | Regenerate `.env.example` from `packages/core/src/env/spec.ts` |
| `pnpm services:up` | Start local PostgreSQL 16, create `hsrb_dev` and `hsrb_test` |
| `pnpm dev` | Run the Next.js app at http://localhost:3000 |

## Layout

- `apps/web`: every HTTP route and screen. Thin: validate, authorize, call a package.
- `packages/core`: contracts, events, ids, errors, logger, env spec. No workspace imports.
- `packages/<domain>`: db, jobs, settings, ai, knowledge, leads, pipeline, scheduling,
  handoff, integrations, evals, observability, widget-embed, `channels/*`.
- `tooling/boundaries.mjs`: which package may import which. Enforced by `pnpm verify`.

## Conventions

- Import packages by entry point (`@repo/core`), never by a path into `src`. Inside a
  package use relative imports. Packages export TypeScript source; there is no build step.
- Strict TypeScript, no `any`, no floating promises. Run `pnpm format` before finishing.
- Validate every boundary with Zod: webhooks, API bodies, tool inputs, job payloads, env.
- Tenant safety: every query for business data goes through a tenant-scoped repository or an
  RLS-enforced connection. Use the branded ids (`BusinessId`, `ConversationId`).
- Configuration: declare variables in the env spec and read them with `getEnv()` /
  `requireEnv()` from `@repo/core/env`. `process.env` is blocked by ESLint. Anything a
  business might tune is a setting, not an env variable.
- Secrets: never print, log or commit one. Tenant credentials are encrypted before storage and
  never sent to the browser or put in a job payload.
- Logging: `logger.child({ traceId, businessId })` from `@repo/core`. Never log message text,
  contact details or tokens.
- Jobs: payloads carry ids only; handlers are idempotent; side effects sit in their own step.
- Model calls go through the client in `packages/ai` and follow ARCHITECTURE §5 (no
  `thinking`, `temperature` or forced `tool_choice`; check `stop_reason`; keep the cached
  prefix stable).
- Tests sit next to the source as `*.test.ts`. Vendor calls are tested with fixtures and an
  injected `fetch`; anything needing a real account goes to `docs/HUMAN_TODO.md` with the
  command for the live check.
- Dependencies: one version each, in the `catalog:` of `pnpm-workspace.yaml`.
- Ambiguity: choose the most reasonable option and add one line to `docs/DECISIONS.md`.
