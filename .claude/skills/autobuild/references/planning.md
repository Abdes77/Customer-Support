# Planning guide

Read this whole file before writing or judging a plan. The plan decides the quality and the
cost of everything after it, and once the run starts nobody is there to correct it.

Contents: 1 What you produce · 2 Spec · 3 Architecture · 4 Milestones · 5 Splitting into
steps · 6 Model and effort · 7 Reviews and frozen tests · 8 Checks · 9 Briefs · 10 plan.json ·
11 KPIs in the plan · 12 Self-check

## 1. What you produce

| File | Purpose |
| --- | --- |
| `docs/SPEC.md` | What is being built: numbered requirements, KPIs, what is out of scope |
| `docs/ARCHITECTURE.md` | How: components, data flow, contracts between components, layout, stack |
| `autobuild/plan.json` | Every step with its model, effort, review, checks and dependencies |
| `autobuild/steps/<id>.md` | One brief per step: the only instructions its builder gets |
| `autobuild/RULES.md` | The copied rules, with the "Environment" section filled in |
| `docs/DECISIONS.md`, `docs/HUMAN_TODO.md` | Started here, appended to during the run |

Work in this order: spec, architecture, milestones, steps, model and effort, self-check. Steps
written before the architecture exists cannot name the contracts they build against, and a
builder who has to guess a contract guesses differently from the builder of the other side.

## 2. Spec

Write `docs/SPEC.md` from the user's answers.

- **Requirements** as a numbered list, `R1`, `R2`, ... One testable statement each ("A client
  user sees only their own business"), not a theme ("security"). These ids go into
  `plan.requirements`, and the plan check refuses a plan in which a requirement has no step.
- **KPIs** as `K1`, `K2`, ... with target and how each is measured (section 11).
- **Decided by default:** every choice you made because the user did not, one line each. Copy
  them to `docs/DECISIONS.md`.
- **Out of scope**, so builders do not gold-plate.

## 3. Architecture

`docs/ARCHITECTURE.md` is the one document every later step leans on, so it is written on the
strongest available tier, normally by the same agent that then writes the plan, at `high`
effort. `xhigh` is justified only when the system is large or unusual enough that a wrong
structure would be copied into dozens of steps: more than about six components, several
tenants or roles sharing data, money or regulated data, or a problem with no well-known shape.
A landing page, a single automation or a standard CRUD app does not qualify. In that case the
architecture is written first by a separate short agent at `xhigh`, and the reason goes into
`autobuild/PLAN_REVIEW.md`. The architecture contains:

- the components and what each is responsible for;
- the main data flows, end to end;
- **the contracts between components**: the exact types, function signatures, events, tables
  and routes one part exposes to another. This is the part the steps depend on most;
- the folder layout and which component owns which path;
- the stack, with a reason for each choice, preferring boring and well-documented tools;
- the security model (who can see and do what) and where secrets live;
- the test strategy: what the fast verify command covers and which slower suites exist;
- how each KPI will be measured.

In an existing codebase the architecture describes what is there first and then what changes.
Do not redesign working code that the request does not touch.

## 4. Milestones

Group steps into milestones that each end with something that runs and is tested.

- **M0 Foundation:** repository scaffold, the verify command, CI, `CLAUDE.md`, and the skeleton
  of the KPI measurement so every later milestone can be measured.
- **M1 Walking skeleton:** the thinnest path through the whole system, end to end, with real
  interfaces and trivial behaviour behind them. It proves the architecture before anything is
  built on it, which is the cheapest moment to find out it is wrong.
- **Feature milestones:** one vertical slice each, in dependency order.
- **Hardening:** the security and reliability pass over the whole system.
- **Acceptance:** final KPI readings, the end-to-end run, the launch checklist and the report.

Every milestone with four or more steps has a step of kind `integrate` after its build steps:
run everything together, fix the seams, bring `docs/ARCHITECTURE.md` back in line with the
code, and list the upcoming briefs that no longer match. The orchestrator corrects those briefs before going on,
so the plan is refreshed at every milestone instead of drifting.

## 5. Splitting into steps

Make a step as small as it can be **while a smaller step would still raise quality or let a
cheaper model produce the same result**. Splitting is the main tool for both goals: a small,
sharply specified step can be built by a cheaper model, checked precisely, and retried
cheaply. Split when one of these applies:

1. **Decisions and typing are mixed.** A few hard decisions followed by a lot of
   implementation becomes a `design` step on a strong model that writes down the contract
   (types, schema, signatures, the list of cases), and `build` steps on cheaper models that
   implement against it. This is the split that removes most of the expensive model time.
2. **The expected behaviour can be written down first.** A strong model writes the tests or
   fixtures as its own step; a cheaper model then makes them pass and may not edit them.
3. **There are several similar units** (connectors, screens, importers, report types). Build
   the first on a stronger model as the exemplar, have it write the pattern down in a short
   document, and build each of the rest as its own step on a cheaper model that follows the
   exemplar.
4. **A part can be verified on its own.** Then it is its own step: a failure stays local and a
   retry redoes little.
5. **The step is simply big.** Aim for what one agent finishes in one focused sitting:
   roughly up to a dozen files or a few hundred lines of new non-test code, and a brief whose
   "Done when" has at most about eight items. Two unrelated verbs in the title ("build X and
   Y") are two steps.

Do not split when:

- the parts share invariants that have to be decided together (a state machine and its
  persistence, a transaction boundary). Splitting there makes both sides guess;
- a part could not fail any check on its own. Merge it with the part that gives it meaning;
- the overhead outweighs the gain. Every step starts a new agent, which has a price of its own
  ("What a step costs" in section 6), and often a second one for the review. So a twenty-line
  change is its own step only when it belongs to a different risk class than its neighbours,
  and tiny steps are a reason to choose a cheap model, never an expensive one.

Steps run one after another, in the order of `plan.steps`, and a step may depend only on steps
listed before it. Declare every real dependency in `depends_on`: when a step cannot be built,
the run leaves out exactly the steps that depend on it and continues with the rest.

A product the size of a multi-channel support bot with an admin panel is typically 40 to 90
steps. A landing page or a single automation is 8 to 20.

## 6. Model and effort

### What a step costs

How Claude Code bills an agent explains most of the rules in this guide.

- **Every turn re-reads the agent's whole context.** A turn is one model call: read a file, run
  a command, edit something. The context starts with the system prompt and the tool
  definitions, which measured about 65,000 tokens in a cloud session with a few connectors,
  and grows with every file read and every command output. An agent that needs 40 turns pays
  for its context 40 times.
- **Repeated context is cached at roughly a tenth of the price** while the agent keeps
  working. The first turn of every agent pays in full, and so does the first turn after a
  long pause, such as a test run of many minutes.
- **The price per token roughly doubles from one tier to the next** between sonnet, opus and
  fable; haiku costs a small fraction of sonnet. Effort adds thinking, which is billed as
  output, the most expensive kind of token.

So the cost of a step is close to turns × context size × model price, and these are the
levers, in order of how much they save without touching quality:

1. **The model tier.** Moving a step down one tier halves it. This is what splitting is for.
2. **Turns.** A brief that names the exact files to read and the exact commands that prove
   the step removes the exploring, which is where turns go. A vague brief is paid for in
   turns on every attempt.
3. **Context.** A short reading list, and checks whose output is short when they pass.
4. **Effort.** One level lower on a step that needs no deliberation.
5. **Agents.** Each agent pays its base context once at full price. On haiku that is nothing;
   on fable it is real money. A review is a whole second agent.

### Choosing

Quality comes first, cost second. A cheaper setting counts as "the same result" only when
something independent would catch a wrong result: the step's checks, its review, or both. So
for each step choose **the cheapest model and the lowest effort for which both hold**:

1. the brief leaves no decision that this model would make badly, and
2. the step's checks and review would catch the mistakes this model is likely to make.

When 1 fails, move the decision into a separate design step rather than raising the whole step.
When 2 fails, add a check or a review rather than raising the model.

The Agent tool takes these aliases. Cost per token roughly doubles with each tier from sonnet
up, and haiku is far below sonnet (check the pricing page if a decision hinges on the ratio).

| Model | Use it for | Usual effort |
| --- | --- | --- |
| `haiku` | Mechanical work that the brief fully determines and a command can verify: scaffolding from a named template, config and CI files, fixtures and seed data, repeating an exemplar across files, docs generated from code. Keep its reading list short. | `low`, `medium` |
| `sonnet` | Implementation against a precise contract where tests exist or are easy to write: CRUD, the second and later units after an exemplar, screens built from an existing component set, test suites for specified behaviour, migrations. | `medium`, `high` |
| `opus` | Implementation that needs real judgment but has a clear spec and tests: pipelines, state machines, schedulers, the first integration with a vendor API, complex UI flows, and the `integrate` steps. All standard reviews. | `high` |
| `fable` | Decisions that shape what comes after and that no command can verify: the contracts, the data and permission model, the design of the core logic or prompts, the evaluation rubric, the threat model, a problem with no known approach. | `high` |

### Fable at xhigh is rationed

Fable at `xhigh` is the most expensive setting in the build by a wide margin, and long steps at
that setting are what exhaust a usage allowance. Treat it as a budget of a few steps:

- **The default for Fable is `high`.** Implementation almost never needs Fable at all once a
  design step has fixed the contract; give it to `opus` or below.
- **Fable at `xhigh` is for a short `design` step or the threat-model part of the `harden`
  pass**, where a wrong decision is copied into everything built afterwards. Keep such a step
  small: it produces a document or a contract, not an implementation. If a step seems to need
  Fable at xhigh and is also long, it is two steps: split the design from the build.
- Each such step carries `xhigh_reason` in `plan.json`: one sentence on why neither Fable at
  `high` nor a design-plus-cheaper-build split would give the same result. Many plans have no
  such step at all, and the example plan has none. The plan check
  refuses the plan without it and warns when there are more than about three, or 8% of the
  steps, whichever is larger.
- **Fable at `max` is not allowed**, and no review runs on Fable above `high`.
- Retries do not raise it: a failed step is retried with the failure explained, then on the
  next model up, then on the strongest model, and effort is never raised above `high` on the
  way. Fable runs at `xhigh` only where this plan says so.

`xhigh` on `opus` is fine for an intricate implementation step and costs about half as much as
the same effort on Fable. `max` on any model is rarely worth it.

Write the reason for each choice in the step's `why`, in one sentence. A reviewer of the plan
reads those sentences to challenge the choice.

## 7. Reviews and frozen tests

A review is a second agent with a fresh context that reads the step's diff after the checks
pass, fixes what it finds, and must leave the checks passing. It is the right safeguard where
judgment is needed, and an expensive one where a command could do the job.

**Frozen tests come first.** When a step's behaviour can be pinned down by tests, have a
stronger model write those tests as a step of their own, and list their paths under `protect`
in the step that implements against them. The gate fails the implementing step if it touched
a protected path, and puts the files back. A `sonnet` or `haiku` builder that has to pass
tests it cannot edit needs no review. This is usually the cheapest safe setup for
implementation work: it replaces a second agent with a command.

The new tests fail until the implementation exists, and the verify command runs them. So the
step that only writes tests sets `"skip_verify": true` and carries a check that the test files
parse and are collected, and the implementing step is the very next step in the plan.

**One review for several small steps.** A row of small, low-risk steps with checks of their
own can run with `review: null` when the milestone's `integrate` step, which reads the same
code anyway, is told in its brief to review their combined diff.

Where a review is still the right tool, set `review` per step:

- `{ "model": "opus", "effort": "high" }` is the standard, and what makes a `sonnet` or
  `haiku` builder safe: the reviewer is stronger than the builder.
- `{ "model": "fable", "effort": "high" }` for steps where a subtle mistake is expensive:
  authorization, tenant isolation, money, data loss, anything that handles secrets.
- `null` when the step's own checks prove it completely (generated files, fixtures, a config
  the next command exercises) or when it is a document that the next `integrate` step
  reconciles anyway.

The plan check refuses a step that nothing would catch: every step needs a review or a command
that always runs for it, and a step on `haiku` or `sonnet` needs a review or an always-run
check of its own. A check that only runs with a credential (`needs_env`) does not count. A
`design` step has no commands that prove it, so it always gets a review. So does the step that
creates the verify command, because every later step is judged by it: its reviewer confirms
that verify really runs the typecheck, the linter and the tests and fails when they fail.

If a review cannot be completed (the reviewer breaks the checks and cannot repair them), the
run tries once more with a fresh reviewer on the strongest model and otherwise keeps the build
as it passed. Such steps are listed as not reviewed in the final report.

## 8. Checks

After every step the orchestrator runs the global verify command and then the step's `checks`.
A step is done only when all exit 0.

- **The verify command** (`plan.verify`, for example `pnpm verify`) is typecheck, lint and the
  fast tests. Keep it under about five minutes; it runs after every step. In a new repository,
  name in `plan.verify_from` the step that creates it: verify runs from that step on. Leave
  `verify_from` out when the command already exists; it then runs for every step.
- **Slow suites** (end-to-end, load, model evaluations) are `checks` on the steps that need
  them, not part of verify.
- **A check is a command that fails when the step is wrong.** `pnpm test --filter scoring`
  is a check; `test -f src/scoring.ts` proves only that a file exists. Prefer package scripts
  over shell one-liners so they run the same everywhere.
- **Live checks** that need a credential are written as
  `{ "cmd": "...", "needs_env": ["STRIPE_API_KEY"] }`. They run when the variable is set and
  are skipped and reported when it is not. Pair each with a check against mocks or recorded
  fixtures that always runs.
- Give a check that can hang its own `timeout_s` (default 1800).
- A check that fails is run once more before it counts, so a flaky test costs seconds instead
  of a whole new attempt. Flaky checks are listed in the final report.
- A step that touches no code may set `"skip_verify": true`; it then needs a review or a check
  of its own.
- A builder can only wait about ten minutes on one command. Keep the commands a builder is
  expected to run under "Done when" shorter than that, and leave the long suites to the gate,
  which has no such limit.

## 9. Briefs

Each `autobuild/steps/<id>.md` is everything its builder is told, so write it for an agent that
has never seen this conversation. Use `assets/step-brief.md` as the shape:

- **Outcome:** what exists when the step is done. Describe the result and the reason for it,
  not a sequence of edits; the builder chooses the route.
- **Read:** the exact files and document sections needed, as a short list. This keeps cheap
  models focused and every model's context small.
- **Owns:** the paths this step may create or change.
- **Do not change:** the paths listed under `protect` for this step, with one line on why
  (for example "the tests from S04 are the specification for this step").
- **Interfaces:** what it consumes from earlier steps and what it must provide to later ones,
  by name, pointing at the section of `docs/ARCHITECTURE.md` that defines them.
- **Done when:** checkable items, each backed by a command where possible. The first is always
  that the verify command exits 0.
- **Out of scope:** the neighbouring work that belongs to another step.

A brief the builder has to interpret is a brief that will be built differently from what you
meant. If you cannot write a sharp "Done when", the step is not understood well enough yet.

## 10. plan.json

`assets/plan.example.json` is a valid small plan. Fields:

| Field | Meaning |
| --- | --- |
| `project` | Short name |
| `branch` | The branch the build is committed to and pushed on |
| `verify`, `verify_from`, `verify_timeout_s` | The global check, the step that creates it (omit if it already exists), its time limit |
| `models` | The tiers that answered the preflight ping; steps may use only these |
| `max_attempts` | Attempts per step before rescue (default 4) |
| `commit_trailer` | Lines to append to every commit message, if the session asks for attribution lines |
| `requirements` | `{ "R1": "one line", ... }`, the same ids as `docs/SPEC.md` |
| `kpis` | `[{ id, name, target, how, step }]`, or `live_only: true` in place of `step` |
| `milestones` | `[{ id, title }]` |
| `steps` | In build order |

Per step: `id` (short, such as `S07`), `title`, `milestone`, `kind` (`design`, `build`, `test`,
`integrate`, `optimize`, `harden`, `accept`, `docs`), `model`, `effort`, `why`, `depends_on`,
`covers` (requirement ids), `checks`, `review`, and where needed `protect` (paths the step may
not change), `xhigh_reason` and `skip_verify`.

Run `node autobuild/ab.mjs validate` as often as you like while writing. It lists every error
and warning and shows the model mix and the steps that run Fable at xhigh.

## 11. KPIs in the plan

A KPI the build cannot measure is a wish. For each KPI decide how it is measured:

- **Measured in the build.** A command produces the number: a simulation or evaluation suite,
  a Lighthouse run, a load test, a timing harness, a cost calculation over recorded runs. One
  step early in the plan (M0 or M1) builds that measurement, so every later milestone can be
  read against it. The measurement writes its readings to `autobuild/kpi.json` as
  `{ "K1": { "value": 0.83, "target": ">= 0.80", "pass": true } }`.
- **Live only.** The number exists only with real users (conversion, retention). The build then
  delivers two things: a proxy measured in the build where one exists, and the
  instrumentation that reports the real number after launch (events, a dashboard, a query),
  with a step that proves the events fire.

Then:

- Steps that move a KPI say so in their brief, with the target.
- After the features exist, add an `optimize` step per KPI that the product can be tuned
  against: measure, find the largest loss, improve, measure again, for a stated number of
  rounds, recording each reading in `docs/KPI_LOG.md`. Its checks prove that the measurement
  ran and the log was written; whether the target was met is reported, not hidden. A missed
  target must not stop the rest of the build.
- The last step, kind `accept`, runs every measurement once more, writes `autobuild/kpi.json`
  and `docs/BUILD_REPORT.md` with target, reading and verdict per KPI, and rewrites
  `docs/HUMAN_TODO.md` as one ordered launch checklist a non-developer can follow.

## 12. Self-check

Before the plan goes to review, confirm:

- Every requirement is covered, and every KPI has a measurement step or is marked live-only
  with instrumentation.
- The first build milestone ends with a walking skeleton that runs end to end.
- No step asks for an account, a production action or a human decision. Those go to
  `docs/HUMAN_TODO.md`, and the step is built against mocks. A builder that reports BLOCKED
  sends the step to a rescue decision, so a brief must never make "blocked" the expected
  outcome.
- Every step could be handed, alone with its brief, to an agent that knows nothing else.
- For every Fable step you can say why Opus would not give the same result, and for every
  Fable step at xhigh why high would not.
- For every expensive step you asked "would a split let a cheaper model do most of this?",
  for every cheap step "what catches it if this is wrong?", and for every review "could
  frozen tests do this job?".
- Every brief names the exact files to read and the exact commands that prove it, so its
  builder does not spend turns exploring.
- `node autobuild/ab.mjs validate` reports no errors, and each warning is either fixed or
  answered in one line in `autobuild/PLAN_REVIEW.md`.
