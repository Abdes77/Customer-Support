---
name: autobuild
description: Plans and then builds a whole software project unattended inside one Claude Code session. Use this whenever the user says they want to build, create, make or automate something new - an automation, bot, agent, workflow, integration, scraper, website, landing page, web app, mobile app, SaaS, dashboard, internal tool or API - even when they only describe the idea ("I want something that answers my leads") and never say autobuild. It asks one round of questions (always including KPIs), writes a plan of small steps with the best model and effort for each (quality first, cost second), has the plan reviewed, then runs every step in its own subagent with tests and reviews until the project is finished, with no further input. Also use it to continue a build when the repository contains autobuild/state.json. Do not use it for a bug fix, a small change or a single feature in existing code.
---

# Autobuild

The user wants to describe what they want, answer questions once, and come back to finished,
tested code. Everything between the answers and the final report happens without them: no
further questions, no approvals, no "shall I continue?".

The run has six stages. Stages 1 and 2 happen while the user is present; after that they are
gone.

1. **Questions**: one round, always covering KPIs.
2. **Preflight**: everything that could need the user, done while they are still there.
3. **Plan**: spec, architecture, and small steps with a model and effort for each.
4. **Plan review**: a mechanical check and three independent critics, then fixes.
5. **Run**: each step in a fresh subagent, gated by checks and a review, committed and pushed.
6. **Finish**: KPI readings, report, pull request.

## Priorities

Quality first, cost second, and both are served by the same two habits:

- **Small, sharply specified steps.** A step is as small as it can be while a smaller one
  would still raise quality or let a cheaper model give the same result.
- **The cheapest setting that something independent can check.** A cheaper model is "the same
  result" only when the step's checks or its review would catch a wrong result.

Fable at `xhigh` effort is what drains a usage allowance fastest. It is rationed to a few
short design steps that each carry a written reason; the default for Fable is `high`, retries
never raise effort above `high`, and Fable at `max` is not used. Section 6 of
`references/planning.md` has the rules, and the plan check enforces them.

## 0. Before anything: new build or resume

- `autobuild/state.json` exists and is not finished: this is a run in progress. Read
  `autobuild/ORCHESTRATOR.md` and continue its loop. Ask nothing.
- The repository has an `AUTOBUILD.md` from the older kit and the user asks to run or continue
  it: follow that file as written. This skill is for new builds.
- Otherwise it is a new build. Look at what is there: an empty repository, or existing code
  with its own stack, tests and conventions that the plan has to fit. If the session has no
  repository at all, the work would not survive the session, so the first question is which
  repository to use.

## 1. Questions

Ask once, and only what changes the design. Use the question tool for choices (two to four
options, your recommendation first), and a short numbered list with a default in brackets for
free-form points. Skip anything the user already said. Whatever stays unanswered, you decide,
and you record the decision in `docs/DECISIONS.md`.

Cover:

1. **Outcome.** What it does, for whom, and the main flow, if their message left that open.
2. **KPIs: always.** If they named no measurable success criteria, propose three to five
   that fit this project, each with a target, and let them pick and adjust. Use
   `references/kpis.md`. If they named loose goals ("more bookings"), turn them into measurable
   KPIs and confirm. Include a cost guardrail when the product calls a paid API on every run.
3. **Scope edges.** Must-have versus later; users, roles and tenancy; languages; sensitive
   data.
4. **Connections.** Which channels, data sources and third-party services, and which accounts
   or keys already exist in this environment. What does not exist will be built against mocks
   and listed for them at the end.
5. **Stack and hosting.** Default: you choose. Ask only if they have existing infrastructure.
6. **Delivery.** A pull request at the end (recommended) or only pushed commits.

One exchange is normal. A second is fine when an answer opens a design-level question you
could not have foreseen. After that, no more questions for the rest of the run.

## 2. Preflight

Do this immediately after the answers and before any planning. Planning takes a while and the
user will leave; anything that might need them has to surface now.

1. **Session settings.** Call `get_session` if the tool exists. The run needs permission mode
   **Auto**; in any other mode it will stop at the first command that needs approval. You
   cannot change the mode yourself.
2. **Branch.** Use the branch this session is told to develop on; otherwise create
   `claude/autobuild` from the default branch.
3. **Copy the tooling** from this skill's folder into the repository:
   `scripts/ab.mjs` to `autobuild/ab.mjs`, `assets/RULES.md` to `autobuild/RULES.md`, and
   `assets/ORCHESTRATOR.md` to `autobuild/ORCHESTRATOR.md`. Commit and push once, so a push
   problem shows up now.
4. **Model ping.** Start four subagents in parallel, one per tier (`haiku`, `sonnet`, `opus`,
   `fable`), effort `low`, prompt "Reply with the single word READY." The tiers that answer
   become `plan.models`. This also brings up any usage consent while the user is there.
5. **Scheduled check-in.** If the session can schedule a recurring message back into itself
   (in Claude Code cloud sessions: `create_trigger` with `cron_expression` `0 * * * *`,
   `initiation` `own_followup`, no session id), create one named "Autobuild check-in" with
   this prompt, and keep its id for step 4 of the plan review:

   > Automatic autobuild check-in, not a message from the user. If you are in the middle of
   > the autobuild loop, ignore this and carry on. Otherwise: if autobuild/state.json exists,
   > read autobuild/ORCHESTRATOR.md, run "node autobuild/ab.mjs next" and continue the run. If
   > it does not exist yet, continue the autobuild planning where it stopped. If next prints
   > "finished", delete this scheduled task.

   This is what restarts the run after a usage limit, an error or an early stop.
6. **Settings file.** Run `node autobuild/ab.mjs settings` and merge what it prints into
   `.claude/settings.json` with the Write or Edit tool: a few allow rules and a Stop hook that
   keeps the session from ending while steps remain. Merge, never overwrite. If the write is
   refused, skip it; the check-in covers the same need.
7. **Tell the user, in a few lines, and keep going in the same turn:**
   - that you have all you need and what will happen (plan, review, build, test, report);
   - if the mode is not Auto: to switch it now, because nothing else can;
   - if the session's own effort is `xhigh` or `max`: that they can lower it to `high`, since
     this session only plans and coordinates and the build agents get their own settings;
   - that they can ask "status" or say "pause" at any time, and what arrives at the end.

## 3. Plan

Read `references/planning.md` in full first. It covers the spec, the architecture, how to
split steps, which model and effort fit which kind of step, reviews, checks, briefs, the
`plan.json` fields and how KPIs are wired in.

In short:

1. Write `docs/SPEC.md`: numbered requirements, the KPIs with targets and how each is
   measured, what you decided by default, what is out of scope.
2. Have one subagent on the strongest available tier at `xhigh` write
   `docs/ARCHITECTURE.md`, with the contracts between components spelled out. In an existing
   codebase it reads the code first.
3. Write `autobuild/plan.json` and one brief per step in `autobuild/steps/`, using
   `assets/plan.example.json` and `assets/step-brief.md` as the shapes. Fill in the
   "Environment" section of `autobuild/RULES.md`.
4. If this session is itself not on the strongest tier, give step 3 to a subagent on the
   strongest tier at `high` with the spec, the architecture and the path of
   `references/planning.md`, and check its result.

## 4. Plan review

The plan is the one thing nobody will correct later, so it is attacked before it runs.

1. `node autobuild/ab.mjs validate`. Fix every error. It checks structure, that every
   requirement and KPI is covered, that cheap steps have something to catch them, and the
   Fable-at-xhigh budget.
2. Start three critics in parallel as read-only subagents. Each gets the paths of
   `docs/SPEC.md`, `docs/ARCHITECTURE.md`, `autobuild/plan.json`, `autobuild/steps/` and this
   skill's `references/planning.md`, is told to look for problems and not to praise, and
   returns findings marked MUST or SHOULD with the step ids and the concrete change:
   - **Completeness and architecture** (strongest tier, `high`): what is missing, what will
     break when the parts meet, which requirement or KPI is covered only on paper.
   - **Step design** (`opus`, `high`): steps that are too big, briefs an agent with no other
     context could not build from, "Done when" items no command proves, wrong or missing
     dependencies, a step that is really two.
   - **Model, effort and cost** (`opus`, `high`): where a cheaper model or lower effort gives
     the same result given the checks and review; where a split would allow it; where a step
     is too weak for its model. It challenges every Fable step and, above all, every Fable
     step at `xhigh`.
3. Apply every MUST unless it is wrong, and the SHOULDs on your judgment. Validate again. If
   the fixes changed the architecture or more than a fifth of the steps, run the first critic
   once more. Two rounds at most.
4. Write `autobuild/PLAN_REVIEW.md`: what each critic found, what you changed, and one line
   for each finding or warning you did not act on. Then `node autobuild/ab.mjs init`, and
   `node autobuild/ab.mjs watchdog <id>` with the check-in's id.
5. Tell the user in four or five lines, without asking anything: the number of steps and
   milestones, the model mix, the steps that run Fable at xhigh and why, and the KPIs with
   targets. Then start the run in the same turn.

## 5. Run

`autobuild/ORCHESTRATOR.md` is the full procedure and the source of truth from here on;
follow it. The loop is:

1. `node autobuild/ab.mjs next` prints one action.
2. For `build` or `review`, start one subagent with exactly the model, effort and prompt it
   printed, in the foreground.
3. `node autobuild/ab.mjs gate --wait 540` (tool timeout 600000 ms) checks the result: the
   agent's report, the verify command, the step's own checks. It commits and pushes on a pass,
   and on a failure decides the retry: same model with the failure explained, then the next
   model up, then the strongest.
4. Repeat until `next` prints `finish`.

You coordinate; you do not write product code, and you do not read the agents' work. The
script holds all the state, so a compacted or resumed conversation loses nothing.

## 6. Finish

Follow "Finish" in `autobuild/ORCHESTRATOR.md`: remove the Stop hook, close the run, delete
the scheduled check-in, open the pull request if the user chose one, and report. The report
states every KPI with target, reading and verdict, and says plainly what was not met and what
could not be verified.

## What holds from the last answer to the final report

- No questions and no waiting. Ambiguity is resolved by choosing and writing one line in
  `docs/DECISIONS.md`.
- Missing accounts, keys and approvals never stop the build: the feature is built against
  mocks or recorded fixtures, the live check is skipped, and the need is listed in
  `docs/HUMAN_TODO.md` with the command that runs the skipped check.
- Nothing touches production: no deploys, migrations, DNS or paid resources.
- A tool call the permission system refuses is not retried in another form. Reach the outcome
  another way or record it in `docs/HUMAN_TODO.md`.
- If the user writes during the run, answer briefly and keep going, unless they ask to stop.

## When this session cannot run the build

In a chat with no repository, shell or subagents, do stages 1, 3 and 4 as far as possible
without the script, and hand over the `autobuild/` folder and the `docs/` files as a download,
with this line to paste into a Claude Code session on the repository, model Fable, permission
mode Auto: "Read autobuild/ORCHESTRATOR.md and run the build it describes."

## Files in this skill

| File | Use |
| --- | --- |
| `references/planning.md` | Read before planning; give its path to the plan critics |
| `references/kpis.md` | Read when proposing KPIs |
| `scripts/ab.mjs` | Copied to `autobuild/ab.mjs`; the state machine for the run |
| `assets/ORCHESTRATOR.md` | Copied to `autobuild/`; the run procedure |
| `assets/RULES.md` | Copied to `autobuild/`; rules for builders and reviewers |
| `assets/step-brief.md` | The shape of a step brief |
| `assets/plan.example.json` | A small valid plan |
