---
name: autobuild
description: Plans and then builds a whole software project unattended with Claude Code. Use this whenever the user says they want to build, create, make or automate something new - an automation, bot, agent, workflow, integration, scraper, website, landing page, web app, mobile app, SaaS, dashboard, internal tool or API - even when they only describe the idea ("I want something that answers my leads") and never say autobuild. It interviews the user in short rounds of questions until it knows enough (always including KPIs), writes a plan of small steps with the best model and effort for each (quality first, cost second), has the plan reviewed, then runs every step in its own subagent with tests and reviews until the project is finished, with no further input. Also use it to continue a build when the repository contains autobuild/state.json. Do not use it for a bug fix, a small change or a single feature in existing code.
---

# Autobuild

The user wants to describe what they want, answer questions, and come back to finished,
tested code. Everything between their last answer and the final report happens without them:
no further questions, no approvals, no "shall I continue?".

The run has six stages. Stages 1 and 2 happen while the user is present; after that they are
gone.

1. **Interview**: short rounds of questions until nothing that matters is open, always
   covering KPIs, closed by a recap the user confirms.
2. **Preflight**: everything that could need the user, done while they are still there.
3. **Plan**: spec, architecture, and small steps with a model and effort for each.
4. **Plan review**: a mechanical check and three independent critics, then fixes.
5. **Handoff and run**: a build session of its own runs each step in a fresh subagent, gated
   by checks and a review, committed and pushed.
6. **Report**: KPI readings, what is unverified, the pull request.

## Priorities

Quality first. Then, among setups that reach that quality reliably, the cheapest. Both are
served by the same habits:

- **Small, sharply specified steps.** A step is as small as it can be while a smaller one
  would still raise quality or let a cheaper model give the same result.
- **The cheapest setting that something independent can check.** A cheaper model is "the same
  result" only when the step's checks or its review would catch a wrong result.
- **Few turns, small contexts.** In Claude Code every turn of every agent re-reads that
  agent's whole context, and this session's turns re-read this whole conversation. So hand
  long writing and reading to subagents, keep your own messages short, and never read what
  you do not need.

Fable at `xhigh` effort is what drains a usage allowance fastest, so it is rationed. The
default for Fable is `high`. `xhigh` is for a few short design steps that each carry a written
reason; retries never raise effort above `high`; Fable at `max` is not used. Section 6 of
`references/planning.md` has the rules, the plan check enforces them, and the same restraint
applies to every agent you start yourself during planning and review.

## 0. Before anything: new build or resume

- **A run exists.** If `autobuild/state.json` is in the repository and is not finished, a
  build is in progress or was interrupted. Continue it only when the user asks you to
  continue, or when the message is the automatic check-in: check out the build branch
  (`branch` in `autobuild/plan.json`), read `autobuild/ORCHESTRATOR.md` and begin with its
  "Start" section, without asking anything. If `start` says another session runs the build,
  that session is doing the work: tell the user how far it is
  (`node autobuild/ab.mjs status --remote`) and leave it alone, unless they ask you to take
  the build over here. If the user came for something else, do that, and mention the
  unfinished build in one line.
- **An older kit.** If the repository has an `AUTOBUILD.md` and the user asks to run or
  continue it, follow that file as written. This skill is for new builds.
- **A new build.** Look at what is there before you ask anything: an empty repository, or
  existing code with its own stack, tests and conventions that the plan has to fit. What the
  repository can tell you, do not ask. If the session has no repository at all, the work would
  not survive the session, so one of the first questions is which repository to use.

## 1. Interview

The interview is the only chance to learn what the user wants, so take as many rounds as it
needs, and keep each round small. A short round is easy to answer well, and each answer lets
you ask a better next question; one long questionnaire gets rushed answers and asks things
that an earlier answer would have made pointless.

How to run it:

- **One topic per round, one to four questions.** Use the question tool for choices (two to
  four options, your recommendation first, the consequence of each option in its
  description), and plain text for open questions. Let every round build on the answers so
  far: drop what they made irrelevant, sharpen what they opened up.
- **Go from the outcome to the details.** A natural order, to be adapted:
  1. *The outcome.* What it does, for whom, the main flow from start to finish, and what
     exists today (a manual process, another tool, nothing).
  2. *Success.* KPIs, always. If the user named no measurable criteria, propose three to five
     that fit this project, each with a target, and let them pick and adjust; use
     `references/kpis.md`. If they named loose goals ("more bookings"), turn them into
     measurable KPIs and confirm. Add a cost guardrail when the product calls a paid API on
     every run.
  3. *Scope.* Must-have versus later; users, roles and tenancy; volumes; languages; what must
     happen when something goes wrong; sensitive data.
  4. *Connections.* Channels, data sources and third-party services, and which accounts or
     keys already exist in this environment. What does not exist will be built against mocks
     and listed for them at the end.
  5. *Constraints and delivery.* Existing infrastructure, stack or hosting they are tied to
     (default: you choose); limits on running costs; a pull request at the end (recommended)
     or only pushed commits.
- **Follow up.** After each answer ask yourself what it changes and what it leaves open, and
  spend a round on that. Before you close, sketch the architecture in your head and look for
  the forks that would be expensive to change later (single or multi-tenant, real-time or
  batch, where data lives, who may see what). Each fork the user has an opinion on is a
  question; the rest you decide.
- **Do not ask what the user cannot or need not answer.** Implementation details, library
  choices and anything with an obvious default are yours to decide; record each decision in
  `docs/DECISIONS.md`. When the user says "you decide" about an area, stop asking about it.
- **Stop when another answer would not change the design, the KPIs or the plan.** More
  rounds than that waste the user's time; fewer leave you guessing during a run in which
  nobody can be asked.
- **Close with a recap.** In about ten lines: what you will build, for whom, the KPIs with
  targets, the main decisions and defaults, what will be mocked for lack of accounts or keys,
  and how it is delivered. Ask whether that is right or what to change. Repeat until they
  confirm. Their confirmation is the last input of the run.

## 2. Preflight

Do this immediately after the recap is confirmed and before any planning. Planning takes a
while and the user will leave; anything that might need them has to surface now.

1. **Session settings.** Call `get_session` if the tool exists and read the permission mode.
   The run needs permission mode **Auto**; in any other mode it stops at the first command
   that needs approval, and you cannot change the mode yourself.
2. **Branch.** Use the branch this session is told to develop on; otherwise create
   `claude/autobuild` from the default branch. This is the build branch.
3. **Copy the tooling** from this skill's folder into the repository: `scripts/ab.mjs` to
   `autobuild/ab.mjs`, `assets/RULES.md` to `autobuild/RULES.md`, `assets/ORCHESTRATOR.md` to
   `autobuild/ORCHESTRATOR.md`, and `references/planning.md` to `autobuild/PLANNING.md`. The
   repository then holds everything a later session needs. Commit and push, so a push problem
   shows up now.
4. **Model ping.** Start four subagents in parallel, one per tier (`haiku`, `sonnet`, `opus`,
   `fable`), effort `low`, prompt "Reply with the single word READY." The tiers that answer
   become `plan.models`. This also brings up any usage consent while the user is there.
5. **Scheduled check-in.** If the session can schedule a recurring message back into itself
   (in Claude Code cloud sessions: `create_trigger`, without a session id), run
   `node autobuild/ab.mjs checkin` and create the task exactly as it prints. Keep its id. It
   restarts the planning after a usage limit, an error or an early stop.
6. **Tell the user, in a few lines, and keep going in the same turn:**
   - that you have all you need and what will happen (plan, review, build, test, report);
   - the permission mode: if it is not Auto, or you could not read it, that the run needs
     Auto and only they can switch it;
   - that the build itself will run in a second session, which you start when the plan is
     ready, and that the final report comes back to this conversation;
   - that they can ask "status" or say "pause" here at any time.

Do not write `.claude/settings.json`. A hook or allow rules there would loosen the user's
own oversight of the session, the permission system refuses it, and the run does not need it.

## 3. Plan

The plan is written by subagents on the strongest available tier, not in this conversation:
they work from files in a clean context, and their long output stays out of the context you
re-read on every later turn. Your job is to give them a complete spec and to judge the result.

1. **Spec.** Write `docs/SPEC.md` yourself, since only you heard the user: numbered
   requirements, the KPIs with targets and how each is measured, every decision you made by
   default, what is out of scope. It must stand on its own; nothing the planner needs may live
   only in this conversation. Start `docs/DECISIONS.md` (including whether the user wants a
   pull request) and `docs/HUMAN_TODO.md`. Commit and push.
2. **Architecture and plan.** Start one subagent on the strongest tier at `high`. Tell it to
   read `autobuild/PLANNING.md` in full, then `docs/SPEC.md`, and this skill's
   `assets/plan.example.json` and `assets/step-brief.md` (give the absolute paths), and to
   produce, in this order: `docs/ARCHITECTURE.md`; `autobuild/plan.json` with `branch` set to
   the build branch and `models` to the tiers that answered; one brief per step in
   `autobuild/steps/`; the "Environment" section of `autobuild/RULES.md`. It runs
   `node autobuild/ab.mjs validate` until there are no errors and returns only a short
   summary: steps per milestone, the model mix, any step on Fable at xhigh with its reason,
   and the warnings it left. In an existing codebase it reads the code first. Keep its agent
   id.

   Only for a large or unusual system, as section 3 of the planning guide defines it, write
   the architecture first with a separate short agent at `xhigh`, and note the reason for
   `autobuild/PLAN_REVIEW.md`.
3. Commit and push.

## 4. Plan review

The plan is the one thing nobody will correct later, so it is attacked before it runs.

1. `node autobuild/ab.mjs validate` must show no errors. It checks structure, that every
   requirement and KPI is covered, that every step has something that would catch a wrong
   result, and the Fable-at-xhigh budget.
2. Start three critics in parallel as read-only subagents. Each is told to read
   `autobuild/PLANNING.md`, `docs/SPEC.md`, `docs/ARCHITECTURE.md`, `autobuild/plan.json` and
   the briefs, to look for problems and not to praise, and to return at most fifteen findings
   marked MUST or SHOULD with the step ids and the concrete change:
   - **Completeness and architecture** (strongest tier, `high`): what is missing, what will
     break when the parts meet, which requirement or KPI is covered only on paper.
   - **Step design** (`opus`, `high`): steps that are too big, briefs an agent with no other
     context could not build from, "Done when" items no command proves, checks that would pass
     without testing anything, wrong or missing dependencies, a step that is really two.
   - **Model, effort and cost** (`opus`, `high`): where a cheaper model or lower effort gives
     the same result given the checks; where frozen tests could replace a review; where a
     split would allow a cheaper model; where a step is too weak for its model. It challenges
     every Fable step and, above all, every Fable step at `xhigh`.
3. Decide which findings to apply: every MUST unless it is wrong, the SHOULDs on your
   judgment. Send that list to the planning agent from stage 3 so it makes the changes with
   everything still in its context (continue it with its agent id; if that is not possible,
   start a fresh agent on the strongest tier at `high` with the same reading list plus the
   findings). It validates again. If the fixes changed the architecture or more than a fifth
   of the steps, run the first critic once more. Two rounds at most.
4. Write `autobuild/PLAN_REVIEW.md`: what each critic found, what was changed, and one line
   for each finding or warning not acted on. Run `node autobuild/ab.mjs agents`, which writes
   the lean agent types for the build session from the finished rules. Then
   `node autobuild/ab.mjs init`, which commits and pushes everything, and
   `node autobuild/ab.mjs watchdog <id>` with your check-in's id.

## 5. Handoff and run

The build runs in a session of its own, started now that everything it needs is committed.
That session begins with an empty context instead of this long conversation, can use the lean
agent types (Claude Code only loads agent types when a session starts), and coordinates on a
cheaper model: the judgment is already in the plan and in the models the plan chose for each
step, so the coordinator only has to follow the script. The script lets exactly one session
run a build; after the handoff it refuses to act in this one.

**With a tool that creates sessions** (in Claude Code cloud sessions: `create_session`):

1. Create the build session with:
   - `title`: "Autobuild run: <project>";
   - `model`: the id of the current Opus model, and `effort`: `medium`;
   - `source_url`: this repository's URL, and both `source_revision` and `outcome_branch`:
     the build branch;
   - `tags`: `["autobuild"]`;
   - `prompt`, exactly: "You are the build session of an unattended autobuild run in this
     repository. The plan is already made and reviewed. Your job is to run it to the end
     without asking anyone anything; nobody is watching this session. Read
     autobuild/ORCHESTRATOR.md and follow it exactly, beginning with its section "Start"."
2. Immediately run `node autobuild/ab.mjs handoff <id of the new session>` and do what its
   output lists, which includes deleting your own scheduled check-in. The build session waits
   for this handoff before it does anything.
3. Schedule one message to yourself for 20 minutes from now (`send_later`) to check that the
   build session started.
4. Tell the user in a few lines, without asking anything, and end your turn: the number of
   steps and milestones, the model mix, the steps that run Fable at xhigh and why (or that
   none do), the KPIs with targets, and that the build is now running in the session named
   "Autobuild run: <project>", with the final report coming back here.

Afterwards this session only does three things, each in as few turns as possible:

- **On your 20-minute timer:** run `node autobuild/ab.mjs status --remote`. If the build
  session has started, answer with one line. If not, look at it with `get_session` and
  `list_events`; when it is still starting up, set the timer once more. When it has failed,
  or has not started after the second timer: stop it (`interrupt_session`), run
  `node autobuild/ab.mjs takeover`, and run the build here as `autobuild/ORCHESTRATOR.md`
  describes.
- **When the build session sends its final report:** give it to the user as it is.
- **When the user writes:** for "status", run `node autobuild/ab.mjs status --remote` and
  answer. For "pause" or "resume", send the build session a message asking it to do that.

**Without such a tool**, or when creating the session fails: run the build in this session.
Give the user the same summary, then read `autobuild/ORCHESTRATOR.md` and begin with its
"Start" section. The loop it describes, in short: `start` and every later command print the
next action; for `build` or `review` you start one subagent with exactly the model, effort
and prompt printed; when it has finished (it is usually launched in the background, and you
are woken when it is done) you run the gate, which checks the work, commits, pushes, decides
any retry, and prints the following action.

Whoever runs the loop coordinates only: no product code, no reading of the agents' work. The
script holds all the state, so a compacted or resumed conversation loses nothing.

## 6. Report

The session that ran the build follows "Finish" in `autobuild/ORCHESTRATOR.md`: it closes the
run, deletes its check-in, opens the pull request if the user chose one, and writes the
report, which states every KPI with target, reading and verdict and says plainly what was not
met and what could not be verified. A build session sends that report here; pass it on.

## What holds from the confirmed recap to the final report

- No questions and no waiting. Ambiguity is resolved by choosing and writing one line in
  `docs/DECISIONS.md`.
- Missing accounts, keys and approvals never stop the build: the feature is built against
  mocks or recorded fixtures, the live check is skipped, and the need is listed in
  `docs/HUMAN_TODO.md` with the command that runs the skipped check.
- Nothing touches production: no deploys, migrations, DNS or paid resources.
- A tool call the permission system refuses is not retried in another form. Reach the outcome
  another way or record it in `docs/HUMAN_TODO.md`.

## When this session cannot run the build

In a chat with no repository, shell or subagents, do the interview and write the spec, the
architecture, the plan and the briefs yourself as far as possible without the script, and
hand over the `autobuild/` folder and the `docs/` files as a download, with this line to paste
into a Claude Code session on the repository (model Opus, effort medium, permission mode
Auto): "Read autobuild/ORCHESTRATOR.md and follow it, beginning with its section Start."

## Files in this skill

| File | Use |
| --- | --- |
| `references/planning.md` | The planning guide; copied to `autobuild/PLANNING.md` for the planner and critics |
| `references/kpis.md` | Read when proposing KPIs |
| `scripts/ab.mjs` | Copied to `autobuild/ab.mjs`; the state machine for the run |
| `assets/ORCHESTRATOR.md` | Copied to `autobuild/`; the run procedure |
| `assets/RULES.md` | Copied to `autobuild/`; rules for builders and reviewers |
| `assets/step-brief.md` | The shape of a step brief |
| `assets/plan.example.json` | A small valid plan |
