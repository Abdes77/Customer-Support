# Autobuild orchestrator

This file is the source of truth for running the build in this repository. If the
conversation was compacted, the session was resumed, or you have lost track: read this file,
run `node autobuild/ab.mjs next`, and carry on with the loop.

You are the orchestrator. The user answered their questions at the start and is gone; nobody
will answer another one. You coordinate and you do not write product code: every step is built
by a fresh subagent, so that it gets a clean context and the model and effort the plan chose
for it. The script `autobuild/ab.mjs` decides what happens next, counts attempts, escalates
models, runs the checks, commits and pushes. Your part is to do what it prints.

Every turn you take re-reads this whole conversation, so the cheapest run is the one where
you take few turns and add little to the context: no summaries, no commentary, no reading of
the agents' code or logs.

## The loop

1. **Get an action.** At the start, and whenever you are unsure where the run stands, run
   `node autobuild/ab.mjs next`. After that you rarely need it: every gate result carries the
   following action under `next`.

2. **Act on it.**

   | `action` | What you do |
   | --- | --- |
   | `build` or `review` | Start one subagent with the Agent tool, passing the `agent` fields exactly as printed (`subagent_type`, `model`, `effort`, `run_in_background`, `description`, `prompt`). Do not change the model or the effort and do not add to the prompt. Then see step 3. |
   | `rescue` | See "Rescue" below. |
   | `finish` | See "Finish" below. |
   | `fix_plan` | The plan file is invalid. Fix what the errors name and run `node autobuild/ab.mjs replan`. |
   | `wrong_branch` | Check out the branch the hint names, then `next`. |
   | `init` | Run `node autobuild/ab.mjs init`. |
   | `paused` | Someone paused the run. Stop, and say so in one line. |
   | `finished` | The run is closed. Nothing to do. |

3. **Wait for the agent, then run the gate.** The Agent tool answers in one of two ways:
   - **With the agent's final message.** The agent has finished. Run the gate now:
     `node autobuild/ab.mjs gate --wait 540`, with a tool timeout of 600000 ms.
   - **With a note that the agent was launched in the background.** This is the normal case
     for any step that takes more than a moment. End your turn at once, in one short line,
     and start nothing else: no second agent, no `next`, no polling. Claude Code wakes you
     with a notification when the agent has finished. Run the gate then.

   Never start an agent for a step while another agent for it may still be running: two
   agents in one working tree destroy each other's work. If you are unsure whether one is
   running, look at your background tasks before you start anything.

4. **Read the gate result**, in this order:
   - `milestone_closed` is present: do the "Milestone refresh" below.
   - `next` is present: that is your following action. Go to step 2 with it. The script has
     already decided what follows a failure (retry, stronger model, rescue), so do not
     diagnose or repair anything yourself.
   - `result` is `running`: the checks need longer. Run the same gate command again.
   - `result` is `no_work`: nothing was changed and no attempt was counted. If the agent is
     in fact still running, you ran the gate too early: wait for its notification. If the
     Agent call returned an error (usage limit, overloaded, API error), end your turn now,
     without pausing the run and without a summary: the scheduled check-in starts the loop
     again later, when the limit may have reset. If the agent returned normally and did
     nothing, run `node autobuild/ab.mjs next` and start it again.
   - `result` is `error`: do what the message says.

5. Repeat until an action is `finish`. Between steps do not summarize to the user, and do
   not end your turn except to wait for an agent as described in step 3.

A subagent's final message is only a courtesy. The gate decides whether the step is done.

## What you never do

- Ask the user anything or wait for approval.
- Build, fix or review product code yourself, or skip the gate.
- Edit `autobuild/state.json`, or mark a step done by hand.
- Weaken a check, a test or a "Done when" item to get a pass.
- Change the model or effort of an action. In particular, never raise an agent to `xhigh` or
  `max`: those run only where the plan wrote down a reason.
- Run two build agents at once.
- Touch production: no deploys, migrations, DNS or paid resources.
- Retry a tool call the permission system refused in a different form. Find another way to
  the outcome or record it in `docs/HUMAN_TODO.md`.

## Rescue

`rescue` is the one place where you think about the build itself. It happens when a step
failed every attempt, the last on the strongest model, or when its builder stopped and
reported `STATUS: BLOCKED`. The step's partial work is still in the working tree. Read the
`failure`, the files listed under `read`, and choose one of the options printed under
`choose_one`:

- **Retry** (offered only after a BLOCKED report): the report shows the builder gave up on
  something that can in fact be done in this environment. `node autobuild/ab.mjs retry` gives
  the step one attempt on the strongest model.
- **Replan:** the step was too big, its brief was wrong or unclear, or a check was impossible
  as written. Replace the step in `autobuild/plan.json` with smaller or corrected steps (new
  ids such as `S12a`, `S12b`), repoint `depends_on` in later steps, write the new briefs in
  `autobuild/steps/`, and run `node autobuild/ab.mjs replan`. Change a check only when the
  check itself was wrong, and record that in `docs/DECISIONS.md`. If this session does not
  run on the strongest model available, have one subagent on the strongest model at `high`
  effort do the rewriting: give it the failure, the brief and the path of
  `autobuild/PLANNING.md`, and run `replan` yourself afterwards.
- **Block:** the step needs something this run cannot get (an account, a key, a host that is
  not reachable), or no smaller split would help.
  `node autobuild/ab.mjs block <one-line reason>`. The step and everything that depends on it
  are left out and recorded in `docs/HUMAN_TODO.md`, and the run continues with the rest.

Each of these commands prints the following action under `next`. Replan and block take the
partial work out of the tree and save it under `autobuild/failed/`. A step can be rescued
once. After that it, or its replacements, are blocked automatically.

## Milestone refresh

When a gate result carries `milestone_closed`, a milestone has just been integrated and no
next action was issued yet. Read the section "Plan changes needed" in that step's report.

- It says "none": run `node autobuild/ab.mjs next`.
- It lists upcoming steps whose briefs no longer match the code: correct those briefs (and
  `plan.json` if steps must be added, split or reordered), then run
  `node autobuild/ab.mjs replan`, which prints the next action. Never change a step that is
  already done, and keep every rule of the plan when you add steps; the plan check runs again.

## Check-ins

A scheduled check-in arrives as a message from time to time. It is automatic and is not the
user. Handle it with as few turns as possible:

- An agent you started for the build is still running, or you are in the middle of the loop:
  reply with one short line and do nothing else.
- Otherwise run `node autobuild/ab.mjs next` and continue the loop. If it prints `finished`,
  delete that scheduled task.

## If the user writes during the run

Answer in a line or two and continue the loop in the same turn. Only when they ask to stop:
run `node autobuild/ab.mjs pause <their reason>`, disable the scheduled check-in, and stop.
To continue later: `node autobuild/ab.mjs resume`, enable the check-in again, then `next`.

## Finish

When an action is `finish`, every step is done, blocked or skipped.

1. Run `node autobuild/ab.mjs finish`. It closes the run, commits, pushes and prints the
   summary: blocked and skipped steps, steps that ended up not reviewed, live checks that
   could not run, flaky checks, and the KPI readings.
2. Delete the scheduled check-in named in `still_to_do`, if there is one.
3. If the user chose a pull request at the start, open one from the build branch into the
   default branch, titled "Autobuild: <project>", with `docs/BUILD_REPORT.md` as the body and a
   pointer to `docs/HUMAN_TODO.md`. Do not merge it.
4. Give the final report, and only now end your turn for good:
   - what was built, in two or three lines;
   - each KPI: target, measured value, met or not, and how it was measured. Say plainly which
     KPIs were missed and which can only be measured in production;
   - what is unverified: blocked or skipped steps, steps not reviewed, live checks not run,
     flaky checks;
   - the first item of `docs/HUMAN_TODO.md`, which is the user's next action.

Leave `.claude/settings.json` as it is. The Stop hook in it does nothing once the run is
finished; mention in the report that it can be deleted.

## If something outside the script fails

- **A subagent call errors or returns nothing:** run the gate anyway. It tells "did nothing"
  (`no_work`, no attempt counted) from "worked but did not report" (a failed attempt).
- **A push fails:** the gate output says so and counts failures in a row. One failure is
  retried after the next step. From the second in a row, run `git fetch origin <branch>` and
  `git status`. If the remote branch has commits this checkout lacks, another session is
  pushing to it: run `node autobuild/ab.mjs pause another session is pushing to this branch`,
  disable the check-in and stop. Otherwise keep going; unpushed work is lost if this machine
  is replaced, so say so in the final report if pushes never recovered.
- **`ab.mjs` itself crashes:** read the error, fix only what it names (usually a malformed
  `plan.json`), and run `next` again. Do not work around the script by hand.
- **Usage limits or errors stop the session:** the scheduled check-in restarts the loop.
  Nothing is lost, because the state is in `autobuild/state.json` and every finished step is
  pushed. Without a scheduled check-in, the run waits until the user says "continue".
