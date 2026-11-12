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
   | `build` or `review` | Start one subagent with the Agent tool, passing the `agent` fields exactly as printed: `subagent_type`, `model`, `effort`, `description`, `prompt`, in the foreground. Do not change the model or effort, and do not add to the prompt. When it returns, run the command in `then` with the tool timeout it gives. |
   | `rescue` | See "Rescue" below. |
   | `finish` | See "Finish" below. |
   | `fix_plan` | The plan file is invalid. Fix what the errors name, run `node autobuild/ab.mjs replan`, then `next`. |
   | `init` | Run `node autobuild/ab.mjs init`. |
   | `paused` | Someone paused the run. Stop, and say so in one line. |
   | `finished` | The run is closed. Nothing to do. |

3. Read the gate's `result`:
   - `pass` or `fail`: go to 1. The script has already decided what follows a failure (retry,
     stronger model, rescue), so do not diagnose or repair anything yourself.
   - `running`: the checks need longer. Run the same gate command again.
   - `error`: do what the message says; it is nearly always "run next first".
   - `milestone_closed` present: see "Milestone refresh" below, then go to 1.
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
- Run two build agents at once. They share one working tree and would break each other's
  checks.
- Touch production: no deploys, migrations, DNS or paid resources.
- Retry a tool call the permission system refused in a different form. Find another way to
  the outcome or record it in `docs/HUMAN_TODO.md`.

## Rescue

`rescue` means a step failed every attempt, the last on the strongest model. Its partial work
is saved as a patch under `autobuild/failed/` and the tree is back at the last good commit. This is the one place
where you think about the build itself. Read `failure.summary` and the log it names, then the
step's brief, and choose:

- **Replan** when the step was too big, its brief was wrong or unclear, or a check was
  impossible as written. Replace the step in `autobuild/plan.json` with smaller or corrected
  steps (new ids such as `S12a`, `S12b`), repoint `depends_on` in later steps, write the new
  briefs in `autobuild/steps/`, and run `node autobuild/ab.mjs replan`. Change a check only
  when the check itself was wrong, and record that in `docs/DECISIONS.md`.
- **Block** when the step needs something this run cannot get (an account, a key, a host that
  is not reachable) or no smaller split would help:
  `node autobuild/ab.mjs block "<one-line reason>"`. The step and everything that depends on
  it are left out and recorded in `docs/HUMAN_TODO.md`, and the run continues with the rest.

A step can be rescued once. After that it, or its replacements, are blocked automatically.

## Milestone refresh

When a gate result carries `milestone_closed`, a milestone has just been integrated. Read the
section "Plan changes needed" in that step's report. If it lists upcoming steps whose briefs
no longer match the code, correct those briefs (and `plan.json` if steps must be added, split
or reordered), then run `node autobuild/ab.mjs replan`. If it says "none", go straight on.
Never change a step that is already done.

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

1. If `.claude/settings.json` contains the Stop hook that runs `autobuild/ab.mjs hook-stop`,
   remove that hook entry with the Edit tool and leave the rest of the file alone.
2. Run `node autobuild/ab.mjs finish`. It closes the run, commits, pushes and prints the
   summary: blocked and skipped steps, reviews that were dropped, live checks that could not
   run, and the KPI readings.
3. Delete the scheduled check-in named in `still_to_do`, if there is one.
4. If the user chose a pull request at the start, open one from the build branch into the
   default branch, titled "Autobuild: <project>", with `docs/BUILD_REPORT.md` as the body and a
   pointer to `docs/HUMAN_TODO.md`. Do not merge it.
5. Give the final report, and only now end your turn:
   - what was built, in two or three lines;
   - each KPI: target, measured value, met or not, and how it was measured. Say plainly which
     KPIs were missed and which can only be measured in production;
   - what is unverified: blocked or skipped steps, dropped reviews, live checks not run;
   - the first item of `docs/HUMAN_TODO.md`, which is the user's next action.

## If something outside the script fails

- A subagent call errors or returns nothing: run the gate anyway. It fails cleanly when there
  is no report, and the retry follows.
- A push fails: the script retries after the next step. Keep going.
- `ab.mjs` itself crashes: read the error, fix only what it names (usually a malformed
  `plan.json`), and run `next` again. Do not work around the script by hand.
- Usage limits or errors stop the session: the scheduled check-in restarts the loop. Nothing
  is lost, because the state is in `autobuild/state.json` and every finished step is pushed.
