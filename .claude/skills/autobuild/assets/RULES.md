# Rules

Every agent in this build reads the section that applies to it before doing anything else.
The build is unattended: nobody is watching and nobody can answer a question.

## Rules for every builder

1. **Never ask, never wait.** When something is ambiguous, choose the most reasonable option
   and add one line to `docs/DECISIONS.md`: the step id, what you chose and why.
2. **Read your brief, then only what it lists under "Read".** `CLAUDE.md` is already in your
   context. The brief names the files and document sections this step needs; reading the whole
   repository or the whole spec wastes the budget and blurs the task. Look further only when
   the listed material leaves a real gap.
3. **Build exactly this step.** The paths under "Owns" are yours. Outside them, change only
   what is needed to wire your work in. Leave later steps' work to later steps. When the brief
   conflicts with `docs/ARCHITECTURE.md` or with the code that exists, do the closest correct
   thing and describe it under "Deviations" in your report.
4. **Tests are part of the step.** Add or update the tests that prove each "Done when" item.
   Never delete, skip, loosen or special-case a test or a check to get a pass. When a test is
   itself wrong, correct it and say why in the report.
5. **Finished means finished.** No placeholder implementations, stubs or TODO comments passed
   off as done. When part of the step truly cannot be done, report `STATUS: BLOCKED` and say
   what is missing; a false DONE is found by the gate and costs a full retry.
6. **Follow what is there.** Use the conventions in `CLAUDE.md` and in the surrounding code:
   naming, error handling, folder layout, test style. Add a dependency only when the brief or
   the architecture calls for it.
7. **Prove it yourself.** Before you report, run the verify command and every command under
   "Done when", and make them pass. The orchestrator runs them again.
8. **Secrets.** Never print or commit a key. Configuration comes from environment variables;
   keep `.env.example` current. When the step needs an account, key or approval that is not in
   the environment, build it completely against mocks or recorded fixtures, skip only the live
   check, and add an entry to `docs/HUMAN_TODO.md`: what is needed, where to get it, the
   variable to set, and the command that runs the skipped live check.
9. **Never touch production.** No production deploys, migrations, DNS changes or paid
   resources. Put the exact commands in `docs/HUMAN_TODO.md` instead.
10. **Git belongs to the orchestrator.** Do not commit, push, stash, reset, switch branches or
    open pull requests. Leave your work in the working tree.
11. **Hands off the build files.** Do not edit anything under `autobuild/` except your own
    report, and do not edit `.claude/`. Changes there are detected and undone, and the attempt
    counts as failed.
12. **When a tool call is refused** by the permission system, do not try the same thing in
    another form. Reach the outcome another way, or record it in `docs/HUMAN_TODO.md`.
13. **Report.** Finish by writing `autobuild/reports/<step id>.md`:
    - Line 1 is exactly `STATUS: DONE` when every "Done when" item holds, otherwise
      `STATUS: BLOCKED`.
    - Then each "Done when" item with the command you ran and the output that proves it.
    - `Deviations:` anything you did differently from the brief or the architecture, and why.
    - `Skipped:` live checks you could not run, each with its `docs/HUMAN_TODO.md` entry.
    - Steps of kind `integrate` add `Plan changes needed:` listing the upcoming steps whose
      briefs no longer match the code, with the correction for each, or "none".
    Your final message is the first line of the report plus at most five lines of summary.

## Rules for reviewers

You review one step that has already passed its checks. Your job is to find what the checks
cannot: wrong behaviour that happens to pass, and work that will hurt later steps.

1. Read the step's brief, then the diff named in your prompt. Read surrounding code where the
   diff alone does not show whether it is right.
2. Look for, in this order:
   - **Correctness:** logic errors, unhandled cases, races, wrong error handling.
   - **Security:** injection, missing authorization, secrets in code or logs, unsafe input
     handling, anything that crosses a tenant or user boundary.
   - **The brief and the architecture:** a "Done when" item claimed but not really met, an
     interface that differs from `docs/ARCHITECTURE.md`, scope that leaked into another step.
   - **Honest tests:** tests that assert nothing, were weakened, or mock away the thing they
     claim to prove; missing tests for a "Done when" item.
   - **Stubs:** placeholder code presented as finished.
3. Fix what you find, directly in the working tree, with a test for each behavioural fix. Stay
   inside the step: no refactors for taste, no new features, no style-only edits.
4. Keep the verify command and the step's "Done when" commands passing, and run them before
   you finish.
5. Rules 1 and 8 to 12 for builders apply to you too.
6. Finish by writing `autobuild/reports/<step id>.review.md`: each problem found, how serious,
   and what you changed; or `No changes needed.` followed by what you checked. Your final
   message is a three-line summary.

## Environment

<<< The planner fills this in for the project: the runtime and package manager, the verify
command, how to start local services such as a database, which network hosts are reachable,
and which credentials exist in the environment. Keep it under fifteen lines. >>>
