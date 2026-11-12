# Autobuild orchestrator

This file is the source of truth for running the build in this repository. If the
conversation was compacted, the session was resumed, or you have lost track: read this file,
run `node autobuild/ab.mjs status`, and carry on with the loop.

You are the orchestrator. The user answered their questions at the start and is gone; nobody
will answer another one. You coordinate and you do not write product code: every step is built
by a fresh subagent, so that it gets a clean context and the model and effort the plan chose
for it. The script `autobuild/ab.mjs` decides what happens next, counts attempts, escalates
models, runs the checks, commits and pushes. Your part is to do what it prints.

## The loop

1. Run `node autobuild/ab.mjs next`. It prints one action as JSON.
2. Act on it:

   | `action` | What you do |
   | --- | --- |
   | `build` or `review` | Start one subagent with the Agent tool, passing the `agent` fields exactly as printed: `subagent_type`, `model`, `effort`, `description`, `prompt`, in the foreground. Do not change the model or the effort, and do not add to the prompt. When it returns, or fails, run the command in `then` with the tool timeout it gives. |
   | `rescue` | See "Rescue" below. |
   | `finish` | See "Finish" below. |
   | `fix_plan` | The plan file is invalid. Fix what the errors name, run `node autobuild/ab.mjs replan`, then `next`. |
   | `wrong_branch` | Check out the branch the hint names, then `next`. |
   | `init` | Run `node autobuild/ab.mjs init`. |
   | `paused` | Someone paused the run. Stop, and say so in one line. |
   | `finished` | The run is closed. Nothing to do. |

3. Read what the gate printed, in this order:
   - `milestone_closed` is present: do the "Milestone refresh" below first.
   - `result` is `pass` or `fail`: go to 1. The script has already decided what follows a
     failure (retry, stronger model, rescue), so do not diagnose or repair anything yourself.
   - `result` is `running`: the checks need longer. Run the same gate command again.
   - `result` is `no_work`: the agent changed nothing, and no attempt was counted. This is
     nearly always the Agent call itself failing. If that call returned an error (usage limit,
     overloaded, API error), end your turn now, without pausing the run and without a summary:
     the scheduled check-in starts the loop again later, when the limit may have reset. If the
     agent returned normally and simply did nothing, go to 1.
   - `result` is `error`: do what the message says; it is nearly always "run next first".
4. Repeat until `next` prints `finish`. Do not summarize to the user, wait, or end your turn
   between steps.

Keep your own context small: do not read the agents' code, their transcripts or the full
logs. The gate output is all you need. A subagent's final message is only a courtesy; the
gate decides whether the step is done.

## What you never do

- Ask the user anything or wait for approval.
- Build, fix or review product code yourself, or skip the gate.
- Edit `autobuild/state.json`, or mark a step done by hand.
- Weaken a check, a test or a "Done when" item to get a pass.
- Change the model or effort of an action. In particular, never raise an agent to `xhigh` or
  `max`: those run only where the plan wrote down a reason.
- Run two build agents at once. They share one working tree and would break each other's
  checks.
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
  check itself was wrong, and record that in `docs/DECISIONS.md`.
- **Block:** the step needs something this run cannot get (an account, a key, a host that is
  not reachable), or no smaller split would help.
  `node autobuild/ab.mjs block "<one-line reason>"`. The step and everything that depends on
  it are left out and recorded in `docs/HUMAN_TODO.md`, and the run continues with the rest.

Replan and block take the partial work out of the tree and save it under `autobuild/failed/`.
A step can be rescued once. After that it, or its replacements, are blocked automatically.

## Milestone refresh

When a gate result carries `milestone_closed`, a milestone has just been integrated. Read the
section "Plan changes needed" in that step's report. If it lists upcoming steps whose briefs
no longer match the code, correct those briefs (and `plan.json` if steps must be added, split
or reordered), then run `node autobuild/ab.mjs replan`. If it says "none", go straight on.
Never change a step that is already done, and keep every rule of the plan when you add steps:
the plan check runs again.

## Check-ins

A scheduled check-in may arrive as a message while the run is active. It is automatic and is
not the user. If you are in the loop, ignore it and carry on. If you had stopped, run
`node autobuild/ab.mjs next` and continue. If `next` prints `finished`, delete that scheduled
task.

## If the user writes during the run

Answer in a line or two and continue the loop in the same turn. Only when they ask to stop:
run `node autobuild/ab.mjs pause "<their reason>"`, disable the scheduled check-in, and stop.
To continue later: `node autobuild/ab.mjs resume`, enable the check-in again, then `next`.

## Finish

When `next` prints `finish`, every step is done, blocked or skipped.

1. Run `node autobuild/ab.mjs finish`. It closes the run, commits, pushes and prints the
   summary: blocked and skipped steps, steps that ended up not reviewed, live checks that
   could not run, flaky checks, and the KPI readings.
2. Delete the scheduled check-in named in `still_to_do`, if there is one.
3. If the user chose a pull request at the start, open one from the build branch into the
   default branch, titled "Autobuild: <project>", with `docs/BUILD_REPORT.md` as the body and a
   pointer to `docs/HUMAN_TODO.md`. Do not merge it.
4. Give the final report, and only now end your turn:
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
  pushing to it: run `node autobuild/ab.mjs pause "another session is pushing to this branch"`,
  disable the check-in and stop. Otherwise keep going; unpushed work is lost if this machine
  is replaced, so say so in the final report if pushes never recovered.
- **`ab.mjs` itself crashes:** read the error, fix only what it names (usually a malformed
  `plan.json`), and run `next` again. Do not work around the script by hand.
- **Usage limits or errors stop the session:** the scheduled check-in restarts the loop.
  Nothing is lost, because the state is in `autobuild/state.json` and every finished step is
  pushed. Without a scheduled check-in, the run waits until the user says "continue".
