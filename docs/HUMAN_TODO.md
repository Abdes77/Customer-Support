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
  The full quality check is `pnpm eval` (entry 10); run this smaller one first.

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

### 9. Review the lead scoring defaults, and know what the service radius cannot do (C5)

- **What:** lead scoring needs no account; it is decided by the qualification, scoring and
  routing settings. Before the first real customer, someone at the agency should read how
  the defaults sort leads (`docs/SETTINGS.md`, categories Qualification, Scoring and
  Routing): weights, the hot/warm thresholds (70/40), what each band leads to, and the fit
  rules (out-of-area and unoffered services are turned away politely by default).
  Worked examples are in `packages/leads/src/assess/leads.test.ts` (15 leads, three
  configurations, every score explained).
- **Known limit:** a **service radius** (`qualification.service_area.radius_miles`) cannot
  be checked: the product has no ZIP-code geography. A lead whose location is not settled
  by the ZIP codes, places or states listed is marked "location unverified" and is never
  booked straight into a meeting; the report asks the team to confirm. Agencies that rely
  on a radius should list the ZIP codes instead, or a developer adds a ZIP centroid table
  (for example the US Census ZCTA gazetteer file) and a distance check in
  `packages/leads/src/assess/service-area.ts`.
- **Variable:** none.
- **Live check:** none. With a key (entry 2), the lead side of a real conversation shows in
  the dev chat (`/dev/chat`): the turn's `update_lead_fields` result carries the routing
  decision, and `lead_reports` holds the report after every turn.

### 10. First live evaluation, prompt tuning and the baseline (C7)

- **What:** the evaluation suite has never run against the Claude API. Everything in
  `pnpm verify` and every `pnpm eval` so far ran against stand-ins (a rule-based bot model, a
  rule-based customer, a judge that evaluates nothing): that proves the harness, not the
  bot. **No quality number exists yet, and no baseline is saved.** The first live run is
  also the first evidence of how the bot handles a renter, a price shopper or a gas smell.
  It needs the key of entry 2 and nothing else. The bot runs on `claude-fable-5-2`; the
  simulated customers and the judge run on `claude-opus-5-5`, so the key's organization
  needs access to both models.
- **Where:** a developer machine with the key in `.env.local` and local PostgreSQL
  (`pnpm services:up`; the evaluation plays in a throwaway database and writes nothing
  else). Nothing is sent to anyone.
- **Variable:** `ANTHROPIC_API_KEY`. For CI: the same key as a repository secret named
  `ANTHROPIC_API_KEY` (GitHub, Settings, Secrets and variables, Actions).
- **Steps, in this order:**

  1. Check the judge before trusting it (eight judge calls, about a minute):

     ```
     pnpm eval --calibrate-judge
     ```

     It shows the judge eight hand-made conversations with one known fault each (an invented
     visit time, a guarantee and a license number the business never stated, a price
     written out in words, a revealed lead score, a mishandled emergency, a booking where
     nobody is booked, a bot that ignores the customer) and one clean one, and prints where
     the verdict is the expected one. It must agree on all of them. Where it does not, read
     what it said: either the rubric needs sharpening (`packages/evals/src/grade/rubric.ts`)
     or the expectation was wrong (`packages/evals/src/calibration/probes.ts`).
  2. A first, smaller run, then the whole suite:

     ```
     pnpm eval --core          # 24 conversations
     pnpm eval                 # all 72
     ```

     Each prints one line per conversation, the verdict and the measured cost, and writes
     `evals-output/<run>/report.html`. Open the report and read conversations, the failing
     ones first: this is what the agency's clients will get.
  3. Expect failures on the first run: the prompt has never been read by the model it was
     written for (entry 2). Fix causes, not conversations: change the prompt as a new
     version (`packages/ai/src/prompt/core`, the tests there say how), or the engine, and
     run again. `pnpm eval --scenario roofing.renter` replays one scenario, `--persona
     emergency` one kind of customer, `--resume <dir>` finishes a run the API interrupted.
     A change to a default setting needs a line in `docs/DECISIONS.md`.
  4. When every scenario passes with zero setting-compliance failures, save the baseline
     and commit it:

     ```
     pnpm eval --save-baseline
     git add packages/evals/baseline/live.json
     ```

     From then on a live run also fails when quality drops against that file.
  5. Add the repository secret (above). The workflow `eval` then runs live on every pull
     request that touches the engine, the prompts, the playbook and knowledge code, lead
     scoring or the settings registry. Until the secret exists it runs against stand-ins
     and says so in its summary. To spend less per pull request, set the repository
     variable `EVAL_ARGS` to `--core`. The workflow file (`.github/workflows/eval.yml`)
     was checked for syntax only: it has not run on GitHub yet. Open a pull request that
     touches `packages/ai` and confirm that the `eval` job runs, prints "Live evaluation"
     and attaches the report as the `eval-report` artifact.
- **What it costs and how long it takes: not measured.** No live call was made, so any
  figure here would be a guess. A conversation is roughly 4 to 10 bot turns of one or two
  model calls each on `claude-fable-5-2` (most of the prompt is read from the cache), one
  short call per customer turn and one judge call on `claude-opus-5-5`. Every run prints
  its cost from the tokens the API reported; `--core` first tells you what a full run will
  cost (three times as much).
- **To decide after the first live runs:**
  - the thresholds (`DEFAULT_THRESHOLDS` in `packages/evals/src/grade/rubric.ts`: pass at
    4.0 of 5, floors, allowed drops). They were set without data. Run `pnpm eval --core
    --reps 3` once to see how much a scenario's score moves between identical runs, and
    keep the allowed drops above that noise;
  - reply effort: replies run at effort `medium` (DECISIONS 50). Compare with `high` by
    changing `model.reply.effort` in a profile of `packages/evals/src/scenarios/profiles.ts`
    for one run, and look at the score, the cost and "Time to write a reply" in the report;
  - whether the simulated customers read like real ones. If they are too cooperative or
    too articulate, edit the persona briefs in `packages/evals/src/scenarios/personas.ts`.
- **If something fails at once:**
  - every conversation "NOT PLAYED (config)": the key is missing or refused (entry 2);
  - a 400 about `strict`: the organization uses customer-managed encryption keys; run with
    `--no-strict` (the judge's answer is validated in code either way);
  - many "NOT PLAYED (serving)" lines: rate limits. Lower `--concurrency` (default 6) and
    finish with `--resume`.

### 11. Website chat: session secret, Supabase Realtime and a first real site (C8)

- **What:** the website chat works end to end locally (`pnpm e2e`: a sample site embeds it,
  a visitor fills the pre-chat form, chats with the offline bot, sends a photo, reloads the
  page) but has not run on a hosted deployment or on a real business website. Three things
  are needed there:
  1. **A session secret.** Without `WIDGET_SESSION_SECRET` a hosted deployment has no website
     chat (the API answers 503). Generate one with `openssl rand -base64 48`. Changing it
     later ends every visitor session (visitors simply start a new chat).
  2. **Supabase Realtime for instant replies.** With `NEXT_PUBLIC_SUPABASE_URL`,
     `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` set (entry 3), the
     server pokes the visitor's browser through a Realtime broadcast
     (`POST {project}/realtime/v1/api/broadcast`) and the browser listens on its Realtime
     websocket; without them the browser polls (every 1.5 s while a reply is pending, every
     6 s otherwise while the chat is open). The broadcast endpoint and the websocket join
     message were written from memory of the Supabase Realtime protocol (Phoenix, `vsn=1.0.0`,
     public broadcast channel) and tested only against a mocked `fetch`: the docs site was not
     reachable from the build VM. In the project, Realtime must allow public broadcast
     channels (Project Settings, Realtime: "Allow public access" on, which is the default
     for projects created before private-only mode). A poke carries no message text. The
     browser sends the key as the join's `access_token` only when it is a JWT (a legacy anon
     key); with a publishable key (`sb_publishable_...`) it relies on the `apikey` parameter.
     If the project refuses the join, the widget simply polls (every 6 s while open): in the
     live check, the websocket's frames must show a `phx_reply` with `"status":"ok"` for the
     `realtime:widget-...` topic.
  3. **The business's site on its allowed list.** In the admin panel (C16) or, until then,
     the setting `channels.widget.allowed_origins` of the business: every address the site is
     served from, for example `https://www.example.com` and `https://example.com`. With an
     empty list the chat shows nowhere.
- **Where:** Vercel project environment variables (entry 3 for Supabase).
- **Variables:** `WIDGET_SESSION_SECRET` (required for the widget), and the three Supabase
  variables above (optional: polling works without them).
- **Live check:** deploy a preview, set the business's allowed origins to a test page you
  control, paste the snippet the admin panel shows (`widgetEmbedInfo` in
  `@repo/channel-widget/server`) into that page, and chat. With Realtime configured, the
  browser's network tab shows one websocket to `<project>.supabase.co/realtime/v1/websocket`
  and replies appear without `GET /api/widget/v1/messages` polls every 1.5 s. Locally, the
  browser test is `pnpm services:up && pnpm e2e` (Chromium for Playwright:
  `pnpm --filter @repo/web exec playwright install chromium`).

### 12. WhatsApp: Meta app, Embedded Signup, webhook and a live conversation (C9)

- **What:** WhatsApp is built and tested against recorded-style fixtures and a fake Graph API
  (`pnpm verify`: signature checks, every inbound type, statuses, the 24-hour window and the
  template fallback, Embedded Signup, templates, voice messages). It has not talked to Meta:
  the build VM had no Meta credentials. Meta's docs were read on 2026-11-12; Graph API
  **v27.0** is assumed (`META_GRAPH_API_VERSION`, default `v27.0`). Needed:
  1. **A Meta app** (developers.facebook.com, My Apps, Create App, type Business) with the
     WhatsApp product. Business verification of the agency's business portfolio and, for
     onboarding clients, Tech Provider status and App Review of `whatsapp_business_messaging`
     and `whatsapp_business_management` (C18 prepares the review pack).
  2. **The webhook.** WhatsApp, Configuration: callback URL `<APP_URL>/api/webhooks/whatsapp`,
     verify token = `META_WEBHOOK_VERIFY_TOKEN` (any random string, `openssl rand -hex 24`).
     Subscribe the fields `messages`, `message_template_status_update`, `account_update`,
     `phone_number_quality_update` and, for numbers that also use the WhatsApp Business app,
     `smb_message_echoes`. Meta signs deliveries with the app secret.
  3. **Embedded Signup** (Facebook Login for Business, Configurations, create one for
     "WhatsApp Embedded Signup"): its id is `META_WHATSAPP_SIGNUP_CONFIG_ID`. Add the app's
     domain to the allowed domains. The admin page that opens it is C16's; the server part is
     `POST /api/oauth/meta/whatsapp`.
  4. **Templates.** Outside the 24-hour window WhatsApp only delivers approved templates. For
     each business, create the suggested templates (`SUGGESTED_TEMPLATES` in
     `@repo/channel-whatsapp/server`, from the admin panel once C16 exists), wait for approval
     (minutes), and set `channels.whatsapp.follow_up_template` (and `staff_reply_template`)
     to their names. Until then, follow-ups after 24 hours are not sent (they fail with
     `window_closed`, visible in the inbox).
  5. **Voice messages (optional).** A Deepgram key (console.deepgram.com, API Keys) in
     `DEEPGRAM_API_KEY`, and the business setting `channels.whatsapp.voice_messages` =
     "transcribe". Without it the bot asks customers to type. The Deepgram request
     (`POST https://api.deepgram.com/v1/listen?model=nova-3`) is written from Deepgram's
     documented API and tested only against a recorded response.
- **Where:** Vercel environment variables; the Meta app dashboard.
- **Variables:** `META_APP_ID`, `NEXT_PUBLIC_META_APP_ID`, `META_APP_SECRET`,
  `META_WEBHOOK_VERIFY_TOKEN`, `META_WHATSAPP_SIGNUP_CONFIG_ID`, optionally
  `META_GRAPH_API_VERSION` and `DEEPGRAM_API_KEY`. For the live checks:
  `META_TEST_WHATSAPP_PHONE_NUMBER_ID`, `META_TEST_WHATSAPP_ACCESS_TOKEN` (WhatsApp, API Setup:
  a temporary token, or a system user token), `META_TEST_WHATSAPP_BUSINESS_ACCOUNT_ID`,
  `META_TEST_WHATSAPP_RECIPIENT` (your own phone, added as a test recipient on API Setup).
- **Live checks that were skipped:**
  1. The Cloud API itself: `pnpm --filter @repo/channel-whatsapp live:check` reads the test
     number, sends `hello_world`, a free-form text and reply buttons to your phone (write to
     the test number first, or the last two fail with 131047, which also proves the window
     rule), and lists the templates.
  2. A real conversation round trip: run the app where Meta can reach it (a preview
     deployment, or `pnpm dev` behind a tunnel such as `cloudflared tunnel --url
     http://localhost:3000`), point the webhook there, connect the test number to a seeded
     business with `pnpm --filter @repo/channel-whatsapp live:check connect --business
     <business id>` (find it with `psql "$DATABASE_URL" -c "select id, name from businesses"`),
     then write to the test number
     from your phone. Expect: blue ticks and "typing…", one reply per burst of messages, a
     photo stored, a voice note answered with "please type", and statuses moving to
     delivered and read in `messages`. Then set the business's `follow_up_template`, push
     the conversation's `last_inbound_at` back 25 hours in the database and send a
     follow-up (C13) or a manual reply (C16): the template must arrive instead of text.
  3. Embedded Signup with a real client number, once the app has Tech Provider access.
- **Checked against Meta's reference in the C9 review (2026-11-12, docs only, nothing sent):**
  the `smb_message_echoes` payload (`message_echoes` with `from`, `to`, `to_user_id`); the
  inbound `from_user_id`/`user_id` fields and that `from`/`wa_id` are left out for users
  with a username; the `account_update` events (DISABLED_UPDATE carries
  `ban_info.waba_ban_state`, which can be REINSTATE).
- **Unverified details (check them in live check 2):**
  1. The BSUID format: the docs give only examples (`US.13491208655302741918`, parent ids
     `US.ENT.…`); anything that is not a phone number is sent as `recipient`.
  2. Meta's media host names: the docs show the media URL as a placeholder and name no
     host. The downloader allows `fbsbx.com`, `facebook.com`, `fbcdn.net`, `whatsapp.net`
     and `cdninstagram.com` (`META_MEDIA_HOST_SUFFIXES`); a photo that fails with "not one
     of Meta's hosts" in the attachment's error means the list needs the host it names.
  3. Whether 131047 (window closed) comes back in the send response or only later as a
     "failed" status webhook: the error-code page says either or both. The send step checks
     the window itself one minute early, so this matters only at the edge; a late 131047
     marks the message failed (`meta_131047`) without a template. To see which: run live
     check 1 when you have not written to the test number for more than 24 hours. If "send
     free-form text" prints `FAIL ... meta_131047`, Meta answers in the response; if it
     prints `ok`, the refusal comes only as a failed status webhook (watch the app's logs or
     WhatsApp Manager), and the one-minute margin is the only guard at the edge.
  4. The default waits for rate-limit codes (`packages/channels/meta/src/errors.ts`).

### 13. Messenger and Instagram: Facebook Login, Page webhooks and live conversations (C10)

- **What:** Messenger and Instagram Direct are built and tested against recorded-style
  fixtures and a fake Graph API (`pnpm verify`: signatures, every inbound kind on both
  platforms, echoes and the hand-over to a person in Meta's inbox, duplicate deliveries, the
  24-hour window and the HUMAN_AGENT tag up to seven days, delivery and read statuses, story
  replies, Facebook Login). Nothing reached Meta: no credentials in the build VM. Meta's docs
  were read on 2026-11-12 (Graph API v27.0, the same Meta app and webhook secrets as
  WhatsApp, entry 12). Needed:
  1. **The Meta app of entry 12**, with the Messenger and Instagram products (use case
     "Engage with customers on Messenger from Meta" and the Instagram messaging one), and
     App Review for `pages_messaging`, `pages_manage_metadata`, `pages_show_list`,
     `instagram_basic`, `instagram_manage_messages`, `business_management` and the
     **Human Agent** feature (without it a person's reply after 24 hours fails; C18 prepares
     the review pack).
  2. **Webhooks.** In the App Dashboard, Webhooks: object **Page**, callback
     `<APP_URL>/api/webhooks/messenger`; object **Instagram**, callback
     `<APP_URL>/api/webhooks/instagram`; verify token = `META_WEBHOOK_VERIFY_TOKEN`. Subscribe
     the Page fields `messages`, `message_echoes`, `message_deliveries`, `message_reads`,
     `message_reactions`, `messaging_postbacks`, `messaging_referrals`,
     `messaging_policy_enforcement`, `standby`, and the Instagram fields `messages`,
     `messaging_postbacks`, `message_reactions`, `messaging_referral`, `messaging_seen`,
     `standby`. Connecting a Page subscribes it to the app (`subscribed_apps`).
  3. **Facebook Login for Business.** Configurations, create one with a **System-user access
     token** (never expires), assets Pages and Instagram accounts, and the permissions of
     step 1. Its id is `META_LOGIN_CONFIG_ID`. The admin page that opens it is C16's (`FB.login`
     with `config_id`, `response_type: "code"`, `override_default_response_type: true`); the
     server part is `POST /api/oauth/meta/facebook`.
  4. **On each client's Page:** in Meta Business Suite, Settings, Messaging (or the Page's
     Advanced messaging settings), leave the app as the Page's messaging app and make sure no
     other automation (Meta Business AI, another bot) answers first; for Instagram, the
     professional account's Settings, Messages and story replies, Message controls,
     **Allow access to messages** must be on.
- **Where:** Vercel environment variables; the Meta app dashboard; each client's Meta
  Business Suite.
- **Variables:** those of entry 12 plus `META_LOGIN_CONFIG_ID`. `META_APP_ID` matters here:
  Messenger echoes of messages our app sent carry it, and without it the bot cannot tell its
  own echoes from another app's. For the live checks: `META_TEST_PAGE_ID`,
  `META_TEST_PAGE_ACCESS_TOKEN` (Graph API Explorer, your app, Get Page Access Token for the
  test Page), `META_TEST_INSTAGRAM_ACCOUNT_ID` (the Page's `instagram_business_account`).
- **Live checks that were skipped:**
  1. The Graph API with the test Page: `pnpm --filter @repo/channel-messenger-instagram
     live:check` reads the Page and its Instagram account and subscribes the app to the
     Page's fields. Then write to the Page from your own Messenger account and run
     `live:check send --to <your PSID>` (and `--instagram --to <your IGSID>` after writing to
     the Instagram account): a text with two quick replies, "seen" and typing. The ids are
     the `sender.id` of your message in the app's logs of a webhook test, or in
     `contact_identities` once the round trip below works.
  2. A real conversation round trip on both platforms: run the app where Meta can reach it
     (a preview deployment, or `pnpm dev` behind `cloudflared tunnel --url
     http://localhost:3000`), point both webhooks there, connect the test Page to a seeded
     business with `pnpm --filter @repo/channel-messenger-instagram live:check connect
     --business <business id>`, then write to the Page and to the Instagram account. Expect:
     "seen" and typing, one reply per burst, quick replies as buttons, a photo stored,
     statuses moving to delivered and read. Then answer the customer yourself from Meta
     Business Suite's inbox: the reply must appear in `messages` as `human_agent` and the
     bot must stay silent (a `takeover_locks` row with source `provider_inbox`).
  3. The window rules: push the conversation's `last_inbound_at` back 25 hours in the
     database and send a manual reply (C16) or a follow-up (C13): a person's reply must go
     out tagged HUMAN_AGENT, the bot's must fail with `window_closed`.
  4. Facebook Login with a real client Page once the app has Advanced Access.
- **Unverified details (check them in live check 2):**
  1. Whether Instagram echoes carry `app_id` or our `metadata` (the webhook reference,
     re-read on 2026-11-12, shows neither on an Instagram echo; Messenger's echo reference
     shows both). Without them the bot matches an echo to what it sent (the provider id, then
     words equal to a whole message or part it sent in the 30 minutes before the echo), so a
     person who repeats a whole bot message word for word, within 30 minutes of it, is taken
     for the bot and the bot keeps answering. Check in live check 2: answer from the
     Instagram inbox and look at the webhook body for `app_id` and `metadata`.
  2. The Page inbox app id: the docs print `26390203743090`; the long-known id is
     `263902037430900`; both are accepted (`PAGE_INBOX_APP_IDS`).
  3. Messenger delivery and read watermarks against our own clock: sends are dated just
     before the request, so a watermark covers them while our clock is not ahead of Meta's
     by more than the request takes; with more skew, the newest message stays "delivered"
     (or "sent") until a later watermark.
  4. The Attachment Upload API for Instagram through the Page (`platform: instagram`,
     multipart `filedata`) and sending by `attachment_id` with `type: image`. Re-read on
     2026-11-12: Instagram's upload page documents the upload as built, but its own send
     example uses `type: "MEDIA_SHARE"` with `payload.attachment_id`, while Messenger's uses
     the media type; the code sends the media type. If an Instagram photo reply fails with
     code 100, try `MEDIA_SHARE` in `attachmentBody`. A staff photo reply (C16) is the first
     real use; Instagram takes only PDF as `file`.
  5. Whether `/me/accounts` lists the Pages of a business integration system user token from
     Facebook Login for Business: the Facebook Login for Business page (re-read 2026-11-12)
     describes the token types and `/me?fields=client_business_id`, not this call, so it is
     unverified. If it comes back empty, the connect route answers "did not share any
     Facebook Page" (400), and the token's Pages have to be read from the client business
     instead (`/{client-business-id}/owned_pages` or `client_pages`).
  6. Messenger's default rate-limit waits and Instagram's 1,000-byte text limit (texts are
     split at 900 characters and trimmed in bytes).

### 14. Email: Gmail, Microsoft 365 and IMAP/SMTP inboxes (C11)

- **What:** the email channel is built and tested without any mail account: IMAP/SMTP against
  a real IMAP and SMTP server started inside the tests (ImapKit with TLS and STARTTLS), Gmail
  and Microsoft Graph against fakes of their APIs (`pnpm verify`: threads on all three, the
  minute poll, Gmail push with its OIDC token, Graph notifications with the handshake and
  `clientState`, OAuth with PKCE and the cookie-bound state, auto-replies, newsletters and
  bounces ignored, a bounce marking our email failed, a person's reply from the mailbox
  handing over, the daily reply limit per thread, the sending limits, private mail servers
  refused). Google's and Microsoft's docs were read on 2026-11-12 (Gmail push, sync and
  `history.list`; Pub/Sub push authentication; Graph `sendMail` with MIME, change
  notifications, `message: delta`). Nothing reached Google or Microsoft: no credentials in the
  build VM. Needed:
  1. **Google Cloud project** (the same one C12's Google Calendar will use):
     - APIs: enable the **Gmail API** and **Cloud Pub/Sub API**.
     - OAuth consent screen: External (or Internal for one Workspace), app name, support
       email, the scopes `https://www.googleapis.com/auth/gmail.readonly` and
       `https://www.googleapis.com/auth/gmail.send`. Both are **restricted** scopes: until
       Google verifies the app (with a security assessment for restricted scopes) only test
       users you list can connect, at most 100.
     - Credentials, OAuth client ID, type Web application, authorized redirect URI
       `<APP_URL>/api/oauth/email/google/callback`. Its id and secret are `GOOGLE_CLIENT_ID`
       and `GOOGLE_CLIENT_SECRET`.
     - Pub/Sub: create a topic (`GOOGLE_PUBSUB_TOPIC`, e.g. `projects/<project>/topics/gmail-push`)
       and give `gmail-api-push@system.gserviceaccount.com` the **Pub/Sub Publisher** role on
       it. Create a **push** subscription to it with endpoint
       `<APP_URL>/api/webhooks/email/gmail`, **Enable authentication** on, a service account
       you create for it (its email is `GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT`), audience left
       empty (it then is the endpoint URL) or set and copied into
       `GOOGLE_PUBSUB_PUSH_AUDIENCE`. Without the topic, Gmail inboxes are polled every
       minute instead.
  2. **Microsoft Entra app registration:** Accounts in any organizational directory and
     personal Microsoft accounts (`MICROSOFT_TENANT_ID=common`), Web redirect URI
     `<APP_URL>/api/oauth/email/microsoft/callback`, a client secret
     (`MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`), delegated Graph permissions
     `offline_access`, `User.Read`, `Mail.Read`, `Mail.Send` (a tenant admin may have to
     consent for work accounts). `MICROSOFT_GRAPH_CLIENT_STATE`: `openssl rand -base64 32`.
     Change notifications need `APP_URL` to be public https; otherwise Microsoft inboxes are
     polled every minute.
  3. **IMAP/SMTP inboxes** need no account of ours: the agency enters the client's mail
     server, user name and password (an app password where the provider requires one). Only
     standard ports (IMAP 993 or 143 with STARTTLS, SMTP 465, 587, 25 or 2525) and public
     addresses are accepted.
- **Where:** Vercel environment variables; Google Cloud console; Microsoft Entra admin center.
- **Variables:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_PUBSUB_TOPIC`,
  `GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT`, `GOOGLE_PUBSUB_PUSH_AUDIENCE` (optional),
  `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID`,
  `MICROSOFT_GRAPH_CLIENT_STATE`, and `APP_URL` (redirect and notification URLs).
  `CREDENTIALS_ENCRYPTION_KEY` also signs the OAuth state (a derived key).
- **Live checks that were skipped:**
  1. An IMAP/SMTP inbox you own: `pnpm --filter @repo/channel-email live:check --address
     office@yourdomain.com --imap-host imap.yourdomain.com --smtp-host smtp.yourdomain.com
     --to you@gmail.com` (the password is asked for on standard input). It logs in to both
     servers with the app's address and TLS rules, finds the Sent folder and sends a test
     email; reply to it and run the command again to see the reply's In-Reply-To.
  2. A real conversation on each connection type: run the app where Google and Microsoft can
     reach it (a preview deployment, or `pnpm dev` behind `cloudflared tunnel --url
     http://localhost:3000` with `APP_URL` set to the tunnel), sign in as agency staff, and
     connect from the browser's console until C16's page exists:
     `fetch("/api/oauth/email/google", {method: "POST", headers: {"content-type":
     "application/json"}, body: JSON.stringify({businessId: "<id>", returnTo: "/"})}).then(r =>
     r.json()).then(r => location.href = r.authorizationUrl)` (and `microsoft`), or `POST
     /api/channels/email/imap` with the server details. Then write to the inbox from another
     account. Expect within a minute (push) or two (poll): one reply in the same thread
     (Gmail and Outlook show it threaded), the signature and the quoted message; reply again
     and get the next answer in the thread. Then answer the customer yourself from the
     mailbox: the bot must stay silent in that thread (`takeover_locks` source
     `provider_inbox`; only mail found in the Sent folder hands over, never mail that merely
     says it is from the business). Send yourself an out-of-office reply and a newsletter: no
     answer. Write with another person in Cc: the bot's reply goes to the sender only
     (`channels.email.reply_to` default `sender`).
  3. Graph's lifecycle: wait for (or force, by deleting the subscription with Graph Explorer)
     a `subscriptionRemoved` lifecycle notification and check that the next sync recreates
     the subscription (`channel_connections.state.subscriptionId` changes).
- **Unverified details (check them in live check 2):**
  1. **Not verified anywhere:** whether Gmail's API keeps our `Message-ID` and the
     `X-HSRB-Loop` header on what it sends, and whether Exchange Online does on MIME
     `sendMail`. Google's sending guide and Graph's `sendMail` reference (re-read 2026-11-12
     in the C11 review) say nothing either way. What the code does about it: our copy in Sent
     is recognized by the loop header, else by its Message-ID, else (Gmail) by the message id
     `messages.send` returned, else by its words (one of our replies of the same thread
     appearing whole above the quote; the only way left on Graph, whose `sendMail` returns no
     id). Any of the last three logs `email.own_send_without_marker`. Check after the first
     bot reply on each provider: that log line must not appear (if it does, the provider
     rewrote the headers: tell the team, threading of customers' replies then rests on
     Gmail's thread id and Outlook's conversation id), no `takeover_locks` row with source
     `provider_inbox` exists for the thread, and the bot answers the customer's next email.
  2. Whether Graph's `message: delta` with `changeType=created` and the `receivedDateTime ge`
     filter returns new messages only once per folder in practice (duplicates are harmless:
     the Message-ID is the idempotency key).
  3. Gmail's `history.list` without a `labelId` on a busy mailbox (pages of 100; one run reads
     at most 8 × 25 messages, the next notification or poll reads on).
  4. The Pub/Sub token's audience when the push subscription leaves it empty (Google's docs
     say it is the endpoint URL; set `GOOGLE_PUBSUB_PUSH_AUDIENCE` if pushes are refused with
     401 and the log says `audience`).
  5. Real mail programs' quoting and signature styles beyond the fixtures (Gmail, Outlook,
     Apple Mail, iPhone): the cleaner keeps a forwarded message and cuts only reply quotes.

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
| Google Cloud project (OAuth client, Pub/Sub topic) | Google Calendar (Gmail: entry 14) | Google | C12 |
| Microsoft Entra app registration | Outlook calendar (mail: entry 14) | Microsoft | C12 |
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

- **Evaluation harness (C7).** The simulated customer and the judge are requests to
  `claude-opus-5-5` built from the same API reference as the engine's (effort always sent,
  no `thinking` or sampling parameters, `tool_choice: auto`, one strict tool for the judge,
  server-side fallbacks, a cached system prompt). No request was sent. Not yet seen live:
  that the judge calls its tool with a valid verdict on the first attempt; that its quotes
  match the transcript often enough to count; that it catches the eight calibration faults;
  how real the simulated customers sound; how long and how expensive a run is; whether six
  conversations at once fit the organization's rate limits. Entry 10 covers all of it.

- Nothing in C0 calls a vendor. The Claude API rules in `docs/ARCHITECTURE.md` §5 come from
  the API reference bundled with the build tools (cached 2026-11-03), not from a live request;
  C4 confirms them with the first live call.
- `CHANNEL_CAPABILITIES` in `packages/core/src/contracts/channel.ts` (message length limits,
  messaging windows, button counts) are baseline values from memory. C8–C11 check each number
  against the vendor's current documentation. WhatsApp's (C9) were checked against Meta's docs
  on 2026-11-12: 4,096 characters, three reply buttons of 20 characters, typing and read
  receipts, the 24-hour window with templates only after it.
- **WhatsApp (C9).** Built from Meta's docs read on 2026-11-12, tested against recorded-style
  fixtures and a fake Graph API; no request reached Meta (entry 12).
- **Messenger and Instagram (C10).** Built from Meta's docs read on 2026-11-12 (Messenger
  Platform webhooks and Send API, Instagram messaging, Facebook Login for Business), tested
  against recorded-style fixtures and a fake Graph API; no request reached Meta (entry 13).
  Their capabilities were checked against the docs: Messenger 2,000 characters, Instagram
  1,000 bytes, 13 quick replies of 20 characters, a 24-hour standard window and seven days
  with the HUMAN_AGENT tag.
- **Email (C11).** Built from Google's and Microsoft's docs read on 2026-11-12. IMAP/SMTP is
  tested against a real IMAP and SMTP server inside the tests (ImapKit, TLS); Gmail and Graph
  against fakes of their APIs. No request reached Google or Microsoft (entry 14). The email
  capabilities in `CHANNEL_CAPABILITIES` are ours to choose: one email per reply, up to
  100,000 characters, images and files as attachments, no messaging window.
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
- **Website chat (C8).** The Supabase Realtime broadcast (`packages/channels/widget/src/realtime.ts`)
  and the browser's Realtime client (`packages/widget-embed/src/browser/realtime.ts`) follow the
  Phoenix protocol as remembered, not as read in current docs, and have not met a real project
  (entry 11). Everything else of the widget runs in `pnpm verify` and `pnpm e2e`. The widget's
  capabilities in `CHANNEL_CAPABILITIES` are ours to choose (no vendor): 2,000 characters a
  message, photos only.
