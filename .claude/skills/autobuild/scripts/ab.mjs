#!/usr/bin/env node
// ab.mjs — state machine for an unattended, step-by-step build (autobuild skill).
//
// Lives at <repo>/autobuild/ab.mjs and is run from anywhere as `node autobuild/ab.mjs <command>`.
// It owns the control flow so the orchestrating session only has to do what `next` prints:
//
//   validate              lint autobuild/plan.json and the step briefs
//   init                  validate, create state.json and .gitignore entries, commit, push
//   next                  print the next action as JSON (build, review, rescue, finish, ...)
//   gate [--wait N]       check the action just issued: report, verify command, step checks
//   replan                re-validate after the plan was edited (rescue or milestone refresh)
//   retry                 rescue option: one more attempt on the strongest model
//   block "<reason>"      rescue option: give up on the step; its dependents are skipped
//   pause "<reason>"      stop issuing actions (also lets the Stop hook release the session)
//   resume                undo pause
//   status [--json]       progress table
//   settings              print the suggested .claude/settings.json (allow rules + Stop hook)
//   watchdog <id>|clear   remember the id of the scheduled check-in so finish can name it
//   finish                close the run once no step is left
//   hook-stop             Stop hook: keeps the session going while steps remain
//
// A gate result carries the following action under "next", so the loop is: start the agent,
// run the gate, start the next agent. An agent that runs longer than a moment is moved to the
// background by Claude Code; the orchestrator then ends its turn and is woken when it finishes.
//
// No dependencies. Node 18 or later. Works without git (commits and pushes are then skipped).

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const DIR = path.dirname(SELF);
const ROOT = path.dirname(DIR);
process.chdir(ROOT);
const AB = path.basename(DIR);
const P = {
  plan: `${AB}/plan.json`,
  state: `${AB}/state.json`,
  steps: `${AB}/steps`,
  reports: `${AB}/reports`,
  logs: `${AB}/logs`,
  rules: `${AB}/RULES.md`,
  orch: `${AB}/ORCHESTRATOR.md`,
  kpi: `${AB}/kpi.json`,
  failed: `${AB}/failed`,
  self: `${AB}/${path.basename(SELF)}`,
};
const ME = `node ${P.self}`;

const TIERS = ['haiku', 'sonnet', 'opus', 'fable'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const HIGH = EFFORTS.indexOf('high');
const KINDS = ['design', 'build', 'test', 'integrate', 'optimize', 'harden', 'accept', 'docs'];
const FINAL = ['done', 'blocked', 'skipped'];
const DEFAULT_ATTEMPTS = 4;
const DEFAULT_TIMEOUT_S = 1800;
const HOLD_MS = 2 * 3600 * 1000;

// ---------- small helpers ----------

const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const readJSON = (f) => { const t = read(f); if (t === null) return null; try { return JSON.parse(t); } catch { return null; } };
const writeFile = (f, text) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, f);
};
const writeJSON = (f, obj) => writeFile(f, JSON.stringify(obj, null, 2) + '\n');
const out = (obj) => { console.log(JSON.stringify(obj, null, 2)); };
const die = (message, extra = {}) => { out({ result: 'error', message, ...extra }); process.exit(1); };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (text) => crypto.createHash('sha256').update(text ?? '').digest('hex');
const tail = (text, chars = 1500) => (text.length > chars ? '…' + text.slice(-chars) : text).trim();
const str = (v) => typeof v === 'string' && v.trim().length > 0;

// ---------- git ----------

const git = (...a) => spawnSync('git', a, { encoding: 'utf8' });
const isRepo = () => git('rev-parse', '--is-inside-work-tree').status === 0;
const head = () => { const r = git('rev-parse', 'HEAD'); return r.status === 0 ? r.stdout.trim() : null; };
// symbolic-ref also works in a repository that has no commit yet.
const branch = () => {
  let r = git('symbolic-ref', '--short', '-q', 'HEAD');
  if (r.status !== 0) r = git('rev-parse', '--abbrev-ref', 'HEAD');
  return r.status === 0 ? r.stdout.trim() : null;
};
const wrongBranch = (plan) => (isRepo() && branch() !== plan.branch
  ? `The checkout is on branch "${branch()}" but this build lives on "${plan.branch}". Run "git fetch origin ${plan.branch}" and "git checkout ${plan.branch}", then try again.`
  : null);

// Commit everything. Returns { ok, sha, error }. "Nothing to commit" is ok.
function commit(message, plan) {
  if (!isRepo()) return { ok: true, sha: null };
  git('add', '-A');
  if (git('diff', '--cached', '--quiet').status === 0) return { ok: true, sha: head() };
  const full = plan && str(plan.commit_trailer) ? `${message}\n\n${plan.commit_trailer.trim()}\n` : message;
  const r = git('commit', '-q', '-m', full);
  if (r.status !== 0) { git('reset', '-q'); return { ok: false, error: tail((r.stderr || '') + (r.stdout || ''), 800) }; }
  return { ok: true, sha: head() };
}

// Push the current branch, retrying network errors. Never fatal; counts failures in a row so
// the orchestrator can tell a blip from a branch that can no longer be pushed.
function push(s) {
  if (!isRepo()) return 'no git repository';
  if (git('remote', 'get-url', 'origin').status !== 0) return 'no remote named origin';
  const b = branch();
  let err = '';
  for (let i = 0; i < 4; i++) {
    const r = git('push', '-q', '-u', 'origin', b);
    if (r.status === 0) {
      if (s && s.push_failures) { s.push_failures = 0; saveState(s); }
      return 'pushed';
    }
    err = tail(r.stderr || '', 300);
    if (i < 3) sleep(2000 * 2 ** i);
  }
  let n = 1;
  if (s) { s.push_failures = (s.push_failures || 0) + 1; n = s.push_failures; saveState(s); }
  return `push failed (${n} in a row${n >= 2 ? `; see "If something outside the script fails" in ${P.orch}` : '; it is retried after the next step'}): ${err}`;
}

// Take an agent's uncommitted work out of the tree without destroying it. The work is saved
// twice: as a patch file inside the repository (committed with the next commit, so it survives
// a fresh clone) and as a git stash (handy while this checkout lives). The plan, the briefs,
// the reports and the two running documents stay where they are. Returns the patch path or null.
function park(label, patchFile) {
  if (!isRepo()) return null;
  const keep = [P.state, P.failed, P.plan, P.steps, P.reports, 'docs/HUMAN_TODO.md', 'docs/DECISIONS.md'].map((f) => `:(top,exclude)${f}`);
  let saved = null;
  if (head()) {
    git('add', '-A');
    const d = spawnSync('git', ['diff', '--cached', '--binary', 'HEAD', '--', ':(top)', ...keep], { encoding: 'utf8', maxBuffer: 1 << 26 });
    git('reset', '-q');
    if (d.status === 0 && d.stdout.trim() && d.stdout.length < 2_000_000) { writeFile(patchFile, d.stdout); saved = patchFile; }
  }
  git('stash', 'push', '-u', '-q', '-m', label, '--', ':(top)', ...keep);
  return saved;
}

// A hash of the whole working tree (tracked and untracked, minus ignored files and state.json).
// Used to tell "the agent did nothing at all" from "the agent worked but wrote no report".
function treeHash() {
  if (!isRepo()) return null;
  fs.mkdirSync(P.logs, { recursive: true });
  const idx = path.resolve(P.logs, 'tree.index');
  fs.rmSync(idx, { force: true });
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  const run = (...a) => spawnSync('git', a, { env, encoding: 'utf8' });
  if (head()) run('read-tree', 'HEAD');
  run('add', '-A', '--', ':(top)', `:(top,exclude)${P.state}`);
  const r = run('write-tree');
  fs.rmSync(idx, { force: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Seconds since an agent last touched a file in the working tree (null when nothing changed).
function lastChange() {
  if (!isRepo()) return null;
  const files = git('status', '--porcelain', '-uall').stdout.split('\n').filter(Boolean)
    .map((l) => l.slice(3).split(' -> ').pop().replace(/^"|"$/g, '')).filter((f) => f !== P.state);
  let newest = 0;
  for (const f of files) { try { newest = Math.max(newest, fs.statSync(f).mtimeMs); } catch { /* deleted */ } }
  return newest ? Math.max(0, Math.round((Date.now() - newest) / 1000)) : null;
}

// A hash of everything under the given paths, for steps that must leave those paths alone.
function pathsHash(paths) {
  if (!isRepo() || !paths || !paths.length) return null;
  fs.mkdirSync(P.logs, { recursive: true });
  const idx = path.resolve(P.logs, 'protect.index');
  fs.rmSync(idx, { force: true });
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  spawnSync('git', ['add', '-A', '--', ...paths.map((x) => `:(top)${x}`)], { env });
  const r = spawnSync('git', ['write-tree'], { env, encoding: 'utf8' });
  fs.rmSync(idx, { force: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

// ---------- plan ----------

function loadPlan() {
  const text = read(P.plan);
  if (text === null) return { plan: null, error: `${P.plan} not found` };
  try { return { plan: JSON.parse(text) }; } catch (e) { return { plan: null, error: `${P.plan}: ${e.message}` }; }
}

const stepIndex = (plan, id) => plan.steps.findIndex((s) => s && s.id === id);
const maxAttempts = (plan) => plan.max_attempts || DEFAULT_ATTEMPTS;
// The verify command runs for every step, or from the step that creates it when verify_from is set.
const verifyRuns = (plan, step) => !step.skip_verify && (!plan.verify_from || stepIndex(plan, step.id) >= stepIndex(plan, plan.verify_from));
const alwaysRun = (c) => typeof c === 'string' || !(Array.isArray(c.needs_env) && c.needs_env.length);

function validate() {
  const errors = [], warnings = [];
  const E = (m) => errors.push(m), W = (m) => warnings.push(m);
  const { plan, error } = loadPlan();
  if (!plan) return { plan: null, errors: [error], warnings };

  for (const k of ['project', 'branch', 'verify']) if (!str(plan[k])) E(`plan.${k} must be a non-empty string`);
  const models = Array.isArray(plan.models) ? plan.models : [];
  if (!models.length) E('plan.models must list the model tiers that answered the preflight ping');
  for (const m of models) if (!TIERS.includes(m)) E(`plan.models: unknown tier "${m}" (use ${TIERS.join(', ')})`);
  const tier = (m) => TIERS.indexOf(m);

  const reqs = plan.requirements && typeof plan.requirements === 'object' && !Array.isArray(plan.requirements) ? plan.requirements : null;
  if (!reqs || !Object.keys(reqs).length) E('plan.requirements must map requirement ids (R1, R2, ...) to one-line descriptions');
  const milestones = Array.isArray(plan.milestones) ? plan.milestones : [];
  if (!milestones.length) E('plan.milestones must be a non-empty array of { id, title }');
  const msIds = new Set(milestones.map((m) => m && m.id));
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  if (!steps.length) E('plan.steps must be a non-empty array');
  if (plan.verify_from !== undefined && !steps.some((s) => s && s.id === plan.verify_from)) E(`plan.verify_from "${plan.verify_from}" is not a step id (leave it out when the verify command already exists)`);
  if (plan.max_attempts !== undefined && !(Number.isInteger(plan.max_attempts) && plan.max_attempts >= 1 && plan.max_attempts <= 6)) E('plan.max_attempts must be an integer from 1 to 6');

  const seen = new Map();
  const covered = new Set();
  steps.forEach((s, i) => {
    const at = `step ${s && s.id ? s.id : `#${i + 1}`}`;
    if (!s || typeof s !== 'object') { E(`${at}: must be an object`); return; }
    if (!str(s.id) || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(s.id)) E(`${at}: id must start with a letter and use only letters, digits, "_", "." and "-"`);
    else if (seen.has(s.id)) E(`${at}: duplicate id`);
    if (!str(s.title)) E(`${at}: title is missing`);
    if (!msIds.has(s.milestone)) E(`${at}: milestone "${s.milestone}" is not in plan.milestones`);
    if (!KINDS.includes(s.kind)) E(`${at}: kind must be one of ${KINDS.join(', ')}`);
    if (!TIERS.includes(s.model)) E(`${at}: model must be one of ${TIERS.join(', ')}`);
    else if (models.length && !models.includes(s.model)) E(`${at}: model "${s.model}" is not in plan.models`);
    if (!EFFORTS.includes(s.effort)) E(`${at}: effort must be one of ${EFFORTS.join(', ')}`);
    if (!str(s.why)) E(`${at}: why is missing (one sentence: why this model, effort and review)`);
    if (!Array.isArray(s.depends_on)) E(`${at}: depends_on must be an array (use [] for none)`);
    else for (const d of s.depends_on) {
      if (d === s.id) E(`${at}: depends on itself`);
      else if (!seen.has(d)) E(`${at}: depends_on "${d}" must be a step listed earlier in plan.steps`);
    }
    if (!Array.isArray(s.covers)) E(`${at}: covers must be an array of requirement ids (use [] for none)`);
    else for (const r of s.covers) { if (reqs && !(r in reqs)) E(`${at}: covers unknown requirement "${r}"`); covered.add(r); }
    const checks = Array.isArray(s.checks) ? s.checks : null;
    if (!checks) E(`${at}: checks must be an array of commands (use [] for none)`);
    else checks.forEach((c, j) => {
      const cmd = typeof c === 'string' ? c : c && c.cmd;
      if (!str(cmd)) E(`${at}: checks[${j}] must be a command string or { cmd, needs_env?, timeout_s? }`);
      if (c && typeof c === 'object' && c.needs_env !== undefined && !Array.isArray(c.needs_env)) E(`${at}: checks[${j}].needs_env must be an array of variable names`);
    });
    if (s.review !== null && (typeof s.review !== 'object' || !TIERS.includes(s.review.model) || !EFFORTS.includes(s.review.effort))) {
      E(`${at}: review must be null or { model, effort }`);
    } else if (s.review) {
      if (models.length && !models.includes(s.review.model)) E(`${at}: review model "${s.review.model}" is not in plan.models`);
      // Opus reviewing Fable's work is the standard; below that, a reviewer should not be weaker than the builder.
      if (tier(s.review.model) < Math.min(tier(s.model), tier('opus'))) W(`${at}: the reviewer (${s.review.model}) is a weaker model than the builder (${s.model})`);
      if (s.review.model === 'fable' && ['xhigh', 'max'].includes(s.review.effort)) E(`${at}: a review on fable runs at high at most`);
    }

    if (s.protect !== undefined && !(Array.isArray(s.protect) && s.protect.every((x) => str(x) && !x.startsWith('/') && !x.split('/').includes('..')))) E(`${at}: protect must be an array of paths inside the repository (the files this step may not change)`);

    // What would catch a wrong result? Only commands that always run count.
    const own = checks ? checks.filter((c) => c && alwaysRun(c)).length : 0;
    const viaVerify = str(s.id) && !s.skip_verify && (!plan.verify_from || steps.findIndex((x) => x && x.id === plan.verify_from) <= i);
    if (!s.review && !own && !viaVerify) E(`${at}: nothing would check this step: no review, no check that always runs, and the verify command does not run for it`);
    else if (!s.review && !own && ['haiku', 'sonnet'].includes(s.model)) E(`${at}: runs on ${s.model} with no always-run check of its own and no review, so nothing would catch a wrong result; add a check, a review, or a stronger model`);
    else if (!s.review && !own && s.kind === 'design') E(`${at}: a design step with no checks needs a review`);
    if (!s.review && s.id === plan.verify_from) E(`${at}: this step creates the verify command that every later step is judged by, so it needs a review`);
    if (!own && ['build', 'test', 'integrate', 'optimize', 'accept'].includes(s.kind)) W(`${at}: has no always-run check of its own; only the global verify command proves it`);

    // The costly settings.
    if (s.model === 'fable' && s.effort === 'max') E(`${at}: fable at max is not allowed; it is the costliest setting and xhigh is the ceiling for this build`);
    else if (s.model === 'fable' && s.effort === 'xhigh') {
      if (!str(s.xhigh_reason)) E(`${at}: fable at xhigh needs "xhigh_reason": one sentence on why neither fable at high nor a split into a design step plus cheaper build steps would give the same result`);
      if (!['design', 'harden'].includes(s.kind)) W(`${at}: fable at xhigh on a "${s.kind}" step; that setting is meant for design decisions and the threat model, so split off the design or drop to high`);
    } else if (s.effort === 'max') W(`${at}: effort max is rarely worth its cost; prefer xhigh`);

    const brief = str(s.id) ? read(`${P.steps}/${s.id}.md`) : null;
    if (str(s.id) && brief === null) E(`${at}: brief ${P.steps}/${s.id}.md is missing`);
    else if (brief !== null) {
      if (!/^#+\s*done when\b/im.test(brief)) E(`${at}: brief has no "Done when" heading`);
      if (!/^#+\s*outcome\b/im.test(brief)) W(`${at}: brief has no "Outcome" heading`);
      if (!/^#+\s*read\b/im.test(brief)) W(`${at}: brief has no "Read" heading, so the builder cannot tell which files it needs`);
      const doneItems = (brief.split(/^#+\s*done when\b.*$/im)[1] || '').split(/^#+\s/m)[0].split('\n').filter((l) => /^\s*[-*]\s+\S/.test(l)).length;
      if (doneItems > 9) W(`${at}: ${doneItems} "Done when" items; it is probably more than one step`);
      if (brief.split('\n').length > 140) W(`${at}: brief is over 140 lines; it is probably more than one step`);
    }
    if (str(s.id)) seen.set(s.id, s);
  });

  if (reqs) for (const r of Object.keys(reqs)) if (!covered.has(r)) E(`requirement ${r} ("${String(reqs[r]).slice(0, 60)}") is not covered by any step`);

  const kpis = Array.isArray(plan.kpis) ? plan.kpis : [];
  if (!kpis.length) E('plan.kpis must list at least one KPI: { id, name, target, how, step }');
  kpis.forEach((k, i) => {
    const at = `kpi ${k && k.id ? k.id : `#${i + 1}`}`;
    for (const f of ['id', 'name', 'target', 'how']) if (!k || !str(k[f])) E(`${at}: ${f} is missing`);
    if (k && k.step) {
      const x = seen.get(k.step);
      if (!x) E(`${at}: step "${k.step}" is not in plan.steps`);
      else if (!(x.checks || []).length) E(`${at}: step ${k.step} measures this KPI but has no check that runs the measurement`);
    } else if (!k || k.live_only !== true) E(`${at}: set "step" to the step whose checks measure it, or "live_only": true when it can only be measured in production`);
  });

  if (steps.length && !errors.length) {
    const fx = steps.filter((s) => s.model === 'fable' && s.effort === 'xhigh').map((s) => s.id);
    const budget = Math.max(3, Math.ceil(steps.length * 0.08));
    if (fx.length > budget) W(`${fx.length} steps run fable at xhigh (${fx.join(', ')}); more than about ${budget} in a plan of ${steps.length} usually means design and implementation were not split apart`);
    const f = steps.filter((s) => s.model === 'fable').length;
    if (f > Math.max(4, Math.ceil(steps.length * 0.25))) W(`${f} of ${steps.length} steps run on fable; check each one against "would opus give the same result, given this step's checks and review?"`);
    if (!steps.some((s) => s.kind === 'harden')) W('no step of kind "harden" (security and reliability pass)');
    if (steps[steps.length - 1].kind !== 'accept') W('the last step should be kind "accept" (final KPI readings, end-to-end run, build report)');
    for (const m of milestones) {
      const own = steps.filter((s) => s.milestone === m.id);
      if (own.length >= 4 && !own.some((s) => ['integrate', 'accept'].includes(s.kind))) W(`milestone ${m.id} has ${own.length} steps but no "integrate" step`);
      if (!own.length) W(`milestone ${m.id} has no steps`);
    }
  }
  return { plan, errors, warnings };
}

// Retry ladder: 2 = same model with the failure explained; 3 = one tier up; 4+ = strongest tier.
// Effort above "high" is the most expensive setting there is, so a retry never adds it: effort
// is raised to "high" at most, and a model the plan did not choose never runs above "high".
// xhigh therefore runs only on the model the plan named, where the plan gave a written reason.
function ladder(plan, step, attempt, forceTop = false) {
  const avail = TIERS.filter((t) => plan.models.includes(t));
  const top = avail.length - 1;
  const planned = Math.max(0, avail.indexOf(step.model));
  let mi = planned;
  let ei = EFFORTS.indexOf(step.effort);
  if (attempt >= 2 && ei < HIGH) ei += 1;
  if (attempt === 3) mi = Math.min(mi + 1, top);
  if (attempt >= 4 || forceTop) mi = top;
  if (attempt >= 3 || forceTop) ei = Math.max(ei, HIGH);
  if (mi !== planned) ei = Math.min(ei, HIGH);
  return { model: avail[mi], effort: EFFORTS[ei] };
}

// Reviewer for each try: 1 and 2 = the planned reviewer; 3 = the strongest model, fresh.
function reviewer(plan, step, reviewTry) {
  if (reviewTry < 3) return { model: step.review.model, effort: step.review.effort };
  const avail = TIERS.filter((t) => plan.models.includes(t));
  const topModel = avail[avail.length - 1];
  return topModel === step.review.model ? { model: topModel, effort: step.review.effort } : { model: topModel, effort: 'high' };
}

// ---------- state ----------

const GUARD = `${P.logs}/guard.json`;
function loadState() { return readJSON(P.state); }
// Every legitimate write of state.json also refreshes the guard's copy of it.
function saveState(s) {
  writeJSON(P.state, s);
  const g = readJSON(GUARD);
  if (g && g.files) { g.state = read(P.state); g.files[P.state] = sha(g.state); writeJSON(GUARD, g); }
}
const st = (s, id) => (s.steps[id] ??= { status: 'todo', attempts: 0 });

function counts(plan, s) {
  const c = { total: plan.steps.length, done: 0, blocked: 0, skipped: 0, todo: 0 };
  for (const step of plan.steps) { const x = (s.steps[step.id] || {}).status || 'todo'; c[x === 'todo' ? 'todo' : x]++; }
  return c;
}

// Mark every step whose dependency was blocked or skipped. One pass is enough because
// dependencies always come earlier in plan.steps. Returns the ids newly skipped.
function cascade(plan, s) {
  const added = [];
  for (const step of plan.steps) {
    const x = st(s, step.id);
    if (FINAL.includes(x.status)) continue;
    const bad = step.depends_on.find((d) => ['blocked', 'skipped'].includes((s.steps[d] || {}).status));
    if (bad) { x.status = 'skipped'; x.reason = `depends on ${bad}, which was not built`; added.push(step.id); }
  }
  return added;
}

// First step that can run.
function pick(plan, s) {
  cascade(plan, s);
  return plan.steps.find((step) => !FINAL.includes(st(s, step.id).status)) || null;
}

// ---------- prompts ----------

function buildPrompt(plan, step, c, failure) {
  const lines = [
    `You are building one step of an unattended software build. Nobody is watching and nobody can answer a question.`,
    `The repository root is ${ROOT}. Work there; every path below is relative to it.`,
    `1. Read ${P.rules} and follow the section "Rules for every builder".`,
    `2. Read ${P.steps}/${step.id}.md and build exactly that step: ${step.id} "${step.title}".`,
    `3. Finish by writing ${P.reports}/${step.id}.md the way the rules describe. Its first line must be "STATUS: DONE" or "STATUS: BLOCKED". Writing it is your last action: after it, change nothing and run nothing.`,
  ];
  if (c.attempt > 1 && failure) {
    lines.push('', `This is attempt ${c.attempt}. The work from earlier attempts is still in the working tree: keep what is good and fix what failed.`, `What went wrong last time: ${failure.summary}`);
    if (failure.log) lines.push(`Full output: ${failure.log}`);
  }
  return lines.join('\n');
}

function reviewPrompt(plan, step, c, failure) {
  const lines = [
    `You are reviewing one step of an unattended software build. Nobody is watching and nobody can answer a question.`,
    `The repository root is ${ROOT}. Work there; every path below is relative to it.`,
    `1. Read ${P.rules} and follow the section "Rules for reviewers".`,
    `2. Read ${P.steps}/${step.id}.md, the brief for step ${step.id} "${step.title}".`,
    c.base && c.built ? `3. The step's changes are: git diff ${c.base} ${c.built}` : `3. The step's changes are the most recent commit: git show HEAD`,
    `4. Fix what you find in the working tree, keep "${plan.verify}" passing, and write ${P.reports}/${step.id}.review.md. Writing it is your last action: after it, change nothing and run nothing.`,
  ];
  const f = failure && failure.phase === 'review' ? failure : null;
  if (c.review_try === 2 && f && f.no_report) {
    lines.push('', `An earlier review of this step ended without writing its report. Anything it changed is still in the working tree (git status shows it). Review the step, check those changes as well, and write the report.`);
  } else if (c.review_try === 2 && f) {
    lines.push('', `An earlier review changed the working tree and the checks now fail. Repair it so they pass again without undoing valid fixes, and bring the review report up to date.`, `What failed: ${f.summary}`);
    if (f.log) lines.push(`Full output: ${f.log}`);
  } else if (c.review_try === 3) {
    lines.push('', `Two earlier review attempts were discarded because they left the checks failing or wrote no report. The working tree is back at the committed code. Review it from scratch.`);
  }
  return lines.join('\n');
}

// ---------- guard: files an agent must not change ----------

function guardFiles() {
  const briefs = fs.existsSync(P.steps) ? fs.readdirSync(P.steps).filter((f) => f.endsWith('.md')).sort().map((f) => `${P.steps}/${f}`) : [];
  return [P.plan, P.rules, P.orch, P.self, P.state, ...briefs];
}
function setGuard(protect) {
  const files = {};
  for (const f of guardFiles()) files[f] = sha(read(f));
  const paths = Array.isArray(protect) && protect.length ? protect : null;
  writeJSON(GUARD, { files, state: read(P.state), tree: treeHash(), protect: paths ? { paths, hash: pathsHash(paths) } : null });
}
// The guard is armed between "next issued an agent" and "gate judged it".
function guardArmed() {
  const g = readJSON(GUARD);
  try {
    const gs = g && g.state ? JSON.parse(g.state) : null;
    return !!(gs && gs.current && gs.current.issued && gs.current.phase !== 'rescue');
  } catch { return false; }
}
// Returns the list of protected files that changed, after restoring them.
function checkGuard() {
  const g = readJSON(GUARD);
  if (!g || !g.files) return [];
  const changed = Object.keys(g.files).filter((f) => sha(read(f)) !== g.files[f]);
  for (const f of changed) {
    if (f === P.state) writeFile(P.state, g.state);
    else if (isRepo()) git('checkout', 'HEAD', '--', f);
  }
  // Paths the step was told to leave alone, typically tests written by an earlier, stronger step.
  if (g.protect && g.protect.hash && pathsHash(g.protect.paths) !== g.protect.hash) {
    const specs = g.protect.paths.map((x) => `:(top)${x}`);
    git('checkout', 'HEAD', '--', ...specs);
    git('clean', '-fdq', '--', ...specs);
    changed.push(...g.protect.paths.map((x) => `${x} (protected for this step: make the code satisfy these files instead of changing them)`));
  }
  return changed;
}

// ---------- commands: validate, init, replan ----------

function cmdValidate() {
  const { errors, warnings, plan } = validate();
  const steps = plan && Array.isArray(plan.steps) ? plan.steps.filter((s) => s && typeof s === 'object') : [];
  const byModel = {};
  for (const s of steps) byModel[`${s.model}/${s.effort}`] = (byModel[`${s.model}/${s.effort}`] || 0) + 1;
  const fableXhigh = steps.filter((s) => s.model === 'fable' && ['xhigh', 'max'].includes(s.effort)).map((s) => ({ id: s.id, title: s.title, reason: s.xhigh_reason || null }));
  out({ result: errors.length ? 'invalid' : 'valid', steps: steps.length, by_model: byModel, fable_at_xhigh: fableXhigh, errors, warnings });
  process.exit(errors.length ? 1 : 0);
}

function ensureIgnore() {
  const want = [`${P.logs}/`, 'node_modules/', '.env', '.env.local'];
  const cur = read('.gitignore') || '';
  const have = cur.split('\n').map((l) => l.trim());
  const add = want.filter((l) => !have.includes(l));
  if (add.length) fs.writeFileSync('.gitignore', (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + add.join('\n') + '\n');
}

function cmdInit() {
  const { errors, warnings, plan } = validate();
  if (errors.length) { out({ result: 'invalid', errors, warnings }); process.exit(1); }
  const notes = [];
  if (isRepo() && branch() !== plan.branch) die(`The current branch is "${branch()}" but plan.branch is "${plan.branch}". Check out ${plan.branch} (create it from the default branch if needed), or correct plan.branch, then run init again.`);
  if (!isRepo()) notes.push('Not a git repository: commits and pushes are skipped.');
  for (const d of [P.reports, P.logs]) fs.mkdirSync(d, { recursive: true });
  fs.rmSync(`${P.logs}/hook.json`, { force: true });
  ensureIgnore();
  let s = loadState();
  if (!s) { s = { version: 1, status: 'running', started_at: now(), current: null, steps: {}, known: plan.steps.map((x) => x.id), watchdog: null }; notes.push('New run.'); }
  else { s.known = plan.steps.map((x) => x.id); notes.push(`Existing run kept: ${counts(plan, s).done} steps already done.`); }
  saveState(s);
  const c = commit(`autobuild: plan for ${plan.project} (${plan.steps.length} steps)`, plan);
  if (!c.ok) notes.push(`Commit failed: ${c.error}`);
  out({ result: 'ready', steps: plan.steps.length, warnings, notes, push: push(s), then: `${ME} next` });
}

function cmdReplan() {
  const { errors, warnings, plan } = validate();
  if (errors.length) { out({ result: 'invalid', errors, warnings, hint: 'Fix the plan and run replan again. The run does not continue until the plan is valid.' }); process.exit(1); }
  const s = loadState() || die(`No ${P.state}. Run init first.`);
  if (s.current && s.current.phase !== 'rescue') die(`Step ${s.current.id} is in progress (${s.current.phase}). Finish it with next and gate before changing the plan.`);
  const fresh = plan.steps.map((x) => x.id).filter((id) => !(s.known || []).includes(id));
  let parked = null;
  if (s.current) {
    const id = s.current.id;
    parked = park(`autobuild: ${id} replaced by replan`, `${P.failed}/${id}.patch`);
    for (const f of fresh) st(s, f).rescue_child = true;
    if (stepIndex(plan, id) >= 0) st(s, id).attempts = 0;
    s.current = null;
  }
  s.known = plan.steps.map((x) => x.id);
  saveState(s);
  commit('autobuild: replan', plan);
  emit({ result: 'replanned', new_steps: fresh, partial_work: parked, warnings, then: `${ME} next` });
}

// ---------- command: next ----------

const cmdNext = () => out(nextAction());

function nextAction() {
  const { errors, plan } = validate();
  if (errors.length) return { action: 'fix_plan', errors, hint: `The plan is invalid. Fix it, then run "${ME} replan".` };
  const s = loadState();
  if (!s) return { action: 'init', hint: `No state yet. Run "${ME} init".` };
  if (s.status === 'paused') return { action: 'paused', reason: s.reason || '', hint: `Run "${ME} resume" to continue.` };
  if (s.status === 'finished') return { action: 'finished', hint: 'The run is closed. Nothing to do.' };
  const wb = wrongBranch(plan);
  if (wb) return { action: 'wrong_branch', hint: wb };
  delete s.hold_at;

  let note;
  if (!s.current) {
    const step = pick(plan, s);
    if (!step) {
      saveState(s);
      return { action: 'finish', progress: counts(plan, s), hint: `No step is left to run. Do the finish procedure in ${P.orch}, which starts with "${ME} finish".` };
    }
    const x = st(s, step.id);
    x.status = 'todo';
    x.attempts = (x.attempts || 0) + 1;
    s.current = { id: step.id, phase: 'build', attempt: x.attempts, base: head(), issued: false };
  } else if (s.current.issued) {
    const c0 = s.current;
    const report = c0.phase === 'build' ? `${P.reports}/${c0.id}.md` : `${P.reports}/${c0.id}.review.md`;
    const idle = lastChange();
    note = read(report) !== null
      ? `This action was already issued and its agent has written ${report}. Do not start the agent again. If its result or its completion notification has reached you, run the gate; if it is still running in the background, end your turn and wait for the notification.`
      : `This action was already issued and its agent has not reported${idle === null ? '' : ` (files in the working tree last changed ${idle}s ago)`}. If that agent is still running, because it was launched in the background and you have not been notified that it finished, start nothing and end your turn. Start the agent only if you are sure none is running for this step.`;
  }

  const c = s.current;
  const step = plan.steps[stepIndex(plan, c.id)];
  if (!step) {
    // The step vanished from the plan (edited outside replan). Drop it and move on.
    s.current = null; saveState(s);
    return nextAction();
  }
  const prog = counts(plan, s);
  const progress = `${prog.done} of ${prog.total} steps done`;

  if (c.phase === 'rescue') {
    saveState(s);
    const gaveUp = c.rescue_reason === 'blocked_report';
    const options = [];
    if (gaveUp && !st(s, step.id).retried) options.push(`Retry: when the report shows the builder gave up on something that can be done in this environment, run "${ME} retry". The step gets one attempt on the strongest model.`);
    options.push(`Replan: when the step was too big or its brief was wrong, replace it in ${P.plan} with smaller or corrected steps (new ids such as ${step.id}a, ${step.id}b; repoint depends_on in later steps), write their briefs in ${P.steps}/, then run "${ME} replan". Never weaken a check to get a pass unless the check itself was wrong, and record that in docs/DECISIONS.md.`);
    options.push(`Block: when the step needs something this run cannot get, run "${ME} block <one-line reason>". The step and everything that depends on it are left out, recorded in docs/HUMAN_TODO.md, and the run continues.`);
    return {
      action: 'rescue', id: step.id, title: step.title, progress,
      why: gaveUp ? `The builder of step ${step.id} stopped and reported BLOCKED.` : `Step ${step.id} failed every attempt, the last on the strongest model.`,
      failure: s.last_failure || null,
      read: [`${P.steps}/${step.id}.md`, gaveUp ? `${P.reports}/${step.id}.md` : (s.last_failure && s.last_failure.log) || null].filter(Boolean),
      choose_one: options,
      note: `The step's partial work is still in the working tree. Replan and block take it out and save it under ${P.failed}/. A step can be rescued once: if it or its replacements fail again they are blocked automatically.`,
    };
  }

  const fresh = !c.issued;
  if (fresh) {
    if (c.phase === 'build') fs.rmSync(`${P.reports}/${step.id}.md`, { force: true });
    else fs.rmSync(`${P.reports}/${step.id}.review.md`, { force: true });
    c.issued = true;
    c.issued_at = now();
  }
  saveState(s);
  if (fresh) setGuard(c.phase === 'build' ? step.protect : null);

  const failure = s.last_failure && s.last_failure.id === step.id ? s.last_failure : null;
  const then = {
    when_the_agent_has_finished: `${ME} gate --wait 540`, tool_timeout_ms: 600000,
    if_it_was_launched_in_the_background: 'End your turn and start nothing else. You are notified when the agent finishes; run the gate then.',
  };
  if (c.phase === 'build') {
    const { model, effort } = ladder(plan, step, c.attempt, c.top);
    return {
      action: 'build', id: step.id, title: step.title, attempt: c.attempt, of: maxAttempts(plan), progress, note,
      agent: { subagent_type: 'general-purpose', model, effort, run_in_background: false, description: `${step.id} build`, prompt: buildPrompt(plan, step, c, failure) },
      then,
    };
  }
  const { model, effort } = reviewer(plan, step, c.review_try);
  return {
    action: 'review', id: step.id, title: step.title, review_try: c.review_try, progress, note,
    agent: { subagent_type: 'general-purpose', model, effort, run_in_background: false, description: `${step.id} review`, prompt: reviewPrompt(plan, step, c, failure) },
    then,
  };
}

// Print a result and, when the run simply continues, the action that follows it. That saves
// the orchestrator one whole turn per step. After an integrate step the plan may need
// changes first, so nothing is issued there.
function emit(res) {
  if (res.then && !res.milestone_closed) { delete res.then; res.next = nextAction(); }
  out(res);
}

// ---------- gate: the checks ----------

const RESULT = `${P.logs}/gate.result.json`;
const PID = `${P.logs}/gate.pid`;
const TRIES = `${P.logs}/gate.tries.json`;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const gateKey = (c) => `${c.id}.${c.phase}.${c.attempt}${c.phase === 'review' ? `.r${c.review_try}` : ''}`;

function gateCommands(plan, step) {
  const cmds = [], skipped = [];
  if (verifyRuns(plan, step)) cmds.push({ cmd: plan.verify, timeout_s: plan.verify_timeout_s || DEFAULT_TIMEOUT_S });
  for (const c of step.checks) {
    const o = typeof c === 'string' ? { cmd: c } : c;
    const missing = (o.needs_env || []).filter((v) => !process.env[v]);
    if (missing.length) skipped.push({ cmd: o.cmd, missing });
    else cmds.push({ cmd: o.cmd, timeout_s: o.timeout_s || DEFAULT_TIMEOUT_S });
  }
  return { cmds, skipped };
}

function killTree(pid) {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F']);
    else process.kill(-pid, 'SIGKILL');
  } catch { /* already gone */ }
}

function runOne(c, logFile) {
  return new Promise((resolve) => {
    fs.appendFileSync(logFile, `\n$ ${c.cmd}\n`);
    const start = fs.statSync(logFile).size;
    const fd = fs.openSync(logFile, 'a');
    const child = spawn(c.cmd, { shell: true, stdio: ['ignore', fd, fd], detached: process.platform !== 'win32', windowsHide: true, env: { ...process.env, CI: process.env.CI || 'true' } });
    let timedOut = false, settled = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, c.timeout_s * 1000);
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { fs.closeSync(fd); } catch { /* closed */ }
      let text = '';
      try { text = fs.readFileSync(logFile).subarray(start).toString('utf8'); } catch { /* log gone */ }
      resolve({ code: timedOut ? 124 : code, timedOut, output: text });
    };
    child.on('error', () => finish(127));
    child.on('close', (code) => finish(code ?? 1));
  });
}

// Detached runner: runs the commands one after another and writes the result file.
async function cmdRunGate(key) {
  const { plan } = loadPlan();
  const s = loadState();
  if (!plan || !s || !s.current || gateKey(s.current) !== key) process.exit(0);
  const step = plan.steps[stepIndex(plan, s.current.id)];
  const { cmds, skipped } = gateCommands(plan, step);
  const logFile = `${P.logs}/${key}.log`;
  fs.mkdirSync(P.logs, { recursive: true });
  fs.writeFileSync(logFile, `# gate ${key} ${now()}\n`);
  writeJSON(PID, { pid: process.pid, key, started: now() });
  const t0 = Date.now();
  let failed = null;
  const ran = [], flaky = [];
  for (const c of cmds) {
    let r = await runOne(c, logFile);
    if (r.code !== 0 && !r.timedOut) {
      // One rerun tells a flaky check from a broken step, far cheaper than a whole new attempt.
      fs.appendFileSync(logFile, `\n# exit code ${r.code}; running it once more to rule out a flaky result\n`);
      r = await runOne(c, logFile);
      if (r.code === 0) flaky.push(c.cmd);
    }
    ran.push(c.cmd);
    if (r.code !== 0) {
      failed = { cmd: c.cmd, code: r.code, summary: `"${c.cmd}" ${r.timedOut ? `timed out after ${c.timeout_s}s` : `exited with code ${r.code} (twice in a row)`}. Last output:\n${tail(r.output)}` };
      break;
    }
  }
  writeJSON(RESULT, { key, ok: !failed, failed, ran, skipped, flaky, seconds: Math.round((Date.now() - t0) / 1000), log: logFile });
  fs.rmSync(PID, { force: true });
}

// ---------- outcomes of a gate ----------

// A build attempt failed.
function fail(plan, s, step, summary, log) {
  const c = s.current;
  const x = st(s, step.id);
  s.last_failure = { id: step.id, phase: 'build', attempt: c.attempt, summary, log: log || null, at: now() };
  c.idle = 0;
  if (c.attempt < maxAttempts(plan) && !c.top) {
    c.attempt++; x.attempts = c.attempt; c.issued = false;
    const up = ladder(plan, step, c.attempt);
    saveState(s);
    return { result: 'fail', id: step.id, summary, log, next_attempt: `${c.attempt} of ${maxAttempts(plan)} on ${up.model}/${up.effort}`, then: `${ME} next` };
  }
  if (x.rescued || x.rescue_child) {
    const r = block(plan, s, step, `it failed every attempt and its one rescue. Last failure: ${summary.split('\n')[0]}`);
    return { result: 'fail', id: step.id, summary, log, blocked: true, ...r };
  }
  return toRescue(s, step, 'exhausted', { result: 'fail', id: step.id, summary, log });
}

function toRescue(s, step, reason, res) {
  const c = s.current;
  st(s, step.id).rescued = true;
  c.phase = 'rescue'; c.rescue_reason = reason; c.issued = false;
  saveState(s);
  return { ...res, rescue: true, then: `${ME} next` };
}

// The builder said it could not finish. A stronger model seldom changes that, so the retry
// ladder is skipped and the orchestrator decides.
function gaveUp(plan, s, step, reportText) {
  const c = s.current;
  const x = st(s, step.id);
  const summary = `The builder reported STATUS: BLOCKED. Its report (${P.reports}/${step.id}.md) says:\n${reportText.split('\n').slice(1).join('\n').trim().slice(0, 1200) || '(nothing more)'}`;
  s.last_failure = { id: step.id, phase: 'build', attempt: c.attempt, summary, log: null, at: now() };
  if (x.rescued || x.rescue_child) {
    const r = block(plan, s, step, `its builder reported BLOCKED again after a rescue. ${reportText.split('\n').find((l, i) => i > 0 && l.trim()) || ''}`.trim());
    return { result: 'fail', id: step.id, summary, blocked: true, ...r };
  }
  return toRescue(s, step, 'blocked_report', { result: 'fail', id: step.id, summary });
}

// The agent was started but nothing changed: almost always the Agent call itself failed
// (usage limit, overload, API error). That must not eat an attempt, or a usage limit would
// march every remaining step up the ladder and into "blocked" within minutes.
function noWork(plan, s, step) {
  const c = s.current;
  c.idle = (c.idle || 0) + 1;
  if (c.idle >= 3) {
    const msg = 'The agent was started three times and changed nothing each time.';
    return c.phase === 'build' ? fail(plan, s, step, msg, null) : failReview(plan, s, step, msg, null, true);
  }
  s.hold_at = now();
  saveState(s);
  return {
    result: 'no_work', id: step.id, count: c.idle,
    hint: `Nothing was changed and no report was written, so no attempt was counted. If the agent is still running, you ran the gate too early: wait for its completion notification. If the Agent call returned an error (usage limit, overloaded, API error), end your turn now without pausing: the scheduled check-in restarts the run. If the agent returned normally and simply did nothing, run "${ME} next" and start it again.`,
  };
}

// A review attempt failed: it wrote no report, or it left the checks failing.
function failReview(plan, s, step, summary, log, noReport = false) {
  const c = s.current;
  s.last_failure = { id: step.id, phase: 'review', attempt: c.attempt, review_try: c.review_try, summary, log: log || null, no_report: noReport, at: now() };
  c.idle = 0;
  if (c.review_try === 1) {
    c.review_try = 2; c.issued = false;
    saveState(s);
    return { result: 'fail', id: step.id, summary, log, note: 'The same reviewer gets one more attempt.', then: `${ME} next` };
  }
  // The second attempt failed too: take the review's changes out and keep the build that passed.
  const parked = park(`autobuild: ${step.id} review changes dropped (try ${c.review_try})`, `${P.failed}/${step.id}.review${c.review_try}.patch`);
  if (c.review_try === 2) {
    c.review_try = 3; c.issued = false;
    saveState(s);
    return { result: 'fail', id: step.id, summary, log, dropped_review: parked, note: 'The review changes were taken out. A fresh review on the strongest model follows.', then: `${ME} next` };
  }
  return { ...finalize(plan, s, step, 'dropped', false), dropped_review: parked, note: 'Three review attempts failed, so the step is kept as built and listed as not reviewed in the final report.' };
}

function block(plan, s, step, reason) {
  const x = st(s, step.id);
  const parked = park(`autobuild: ${step.id} blocked`, `${P.failed}/${step.id}.patch`);
  if (parked) x.partial_work = parked;
  x.status = 'blocked'; x.reason = reason; x.blocked_at = now();
  s.current = null;
  const skipped = cascade(plan, s);
  const todo = 'docs/HUMAN_TODO.md';
  const line = `- [ ] Autobuild could not build step ${step.id} "${step.title}": ${reason}${skipped.length ? ` Left out because they depend on it: ${skipped.join(', ')}.` : ''} Brief: ${P.steps}/${step.id}.md.${x.partial_work ? ` Its partial work is saved as ${x.partial_work} (apply with "git apply").` : ''}\n`;
  const cur = read(todo);
  writeFile(todo, (cur === null ? '# Human to-do\n\n' : cur.endsWith('\n') ? cur : cur + '\n') + line);
  saveState(s);
  commit(`${step.id}: blocked`, plan);
  return { blocked_step: step.id, also_skipped: skipped, partial_work: x.partial_work || null, recorded_in: todo, push: push(s), then: `${ME} next` };
}

function finalize(plan, s, step, review, strict = true) {
  const prev = JSON.stringify(s);
  const c = s.current;
  const x = st(s, step.id);
  const used = ladder(plan, step, c.attempt, c.top);
  Object.assign(x, { status: 'done', done_at: now(), model: used.model, effort: used.effort, review });
  s.current = null;
  if (s.last_failure && s.last_failure.id === step.id) delete s.last_failure;
  saveState(s);
  const r = commit(c.phase === 'build' ? `${step.id}: ${step.title}` : `${step.id}: review`, plan);
  if (!r.ok && strict) {
    // A commit hook rejected the work: that is a failed check, not a finished step.
    const back = JSON.parse(prev);
    for (const k of Object.keys(s)) delete s[k];
    Object.assign(s, back);
    const msg = `git commit was rejected:\n${r.error}`;
    return s.current.phase === 'build' ? fail(plan, s, step, msg, null) : failReview(plan, s, step, msg, null);
  }
  const prog = counts(plan, s);
  const res = { result: 'pass', id: step.id, done: true, review, progress: `${prog.done} of ${prog.total} steps done`, push: push(s), then: `${ME} next` };
  if (step.kind === 'integrate') {
    res.milestone_closed = `Read the section "Plan changes needed" in ${P.reports}/${step.id}.md. If it lists any, amend the upcoming steps and run "${ME} replan"; otherwise run "${ME} next".`;
    delete res.then;
  }
  return res;
}

// Checks that need no command: was a report written, and what does it say?
function quickChecks(plan, s, step) {
  const c = s.current;
  const g = readJSON(GUARD) || {};
  const untouched = () => !!g.tree && treeHash() === g.tree;
  if (c.phase === 'build') {
    const file = `${P.reports}/${step.id}.md`;
    const text = read(file);
    const first = ((text || '').split('\n').find((l) => l.trim()) || '').trim();
    if (!first) return untouched() ? noWork(plan, s, step) : fail(plan, s, step, `The builder changed files but wrote no report at ${file}.`, null);
    if (/^STATUS:\s*BLOCKED\b/.test(first)) return gaveUp(plan, s, step, text.trim());
    if (first !== 'STATUS: DONE') return fail(plan, s, step, `The builder's report starts with "${first.slice(0, 200)}" instead of "STATUS: DONE".`, null);
    return null;
  }
  if (read(`${P.reports}/${step.id}.review.md`) === null) {
    return untouched() ? noWork(plan, s, step) : failReview(plan, s, step, `The reviewer changed files but wrote no report at ${P.reports}/${step.id}.review.md.`, null, true);
  }
  return null;
}

async function cmdGate(args) {
  const wi = args.indexOf('--wait');
  const wait = wi >= 0 ? Math.max(5, Number(args[wi + 1]) || 100) : 100;
  // Undo any edit an agent made to the protected files before trusting what they say.
  const pidNow = readJSON(PID);
  const busy = readJSON(RESULT) || (pidNow && alive(pidNow.pid));
  const tampered = guardArmed() && !busy ? checkGuard() : [];
  const { plan, error } = loadPlan();
  if (!plan) die(error);
  const s = loadState() || die(`No ${P.state}. Run init first.`);
  const wb = wrongBranch(plan);
  if (wb) die(wb);
  const c = s.current;
  if (!c) die('No step is in progress. Run next.');
  if (c.phase === 'rescue') die(`Step ${c.id} is in rescue. Run next for the options.`);
  if (!c.issued) die('The next action has not been issued yet. Run next, start the agent it describes, then gate.');
  const step = plan.steps[stepIndex(plan, c.id)];
  const key = gateKey(c);
  const failNow = (summary, log) => (c.phase === 'build' ? fail(plan, s, step, summary, log) : failReview(plan, s, step, summary, log));
  if (tampered.length) { emit(failNow(`The agent changed files it must not touch: ${tampered.join('; ')}. They were restored. Do the work without editing them.`, null)); return; }

  let res = readJSON(RESULT);
  if (!res || res.key !== key) {
    res = null;
    const p = readJSON(PID);
    let runner = p && p.key === key && alive(p.pid) ? p.pid : null;
    let exited = false;
    if (!runner) {
      const q = quickChecks(plan, s, step);
      if (q) { emit(q); return; }
      if (s.hold_at) { delete s.hold_at; saveState(s); }
      const t = readJSON(TRIES) || {};
      const n = t.key === key ? (t.n || 0) + 1 : 1;
      writeJSON(TRIES, { key, n });
      if (n > 3) {
        res = { key, ok: false, failed: { summary: `The check runner could not finish three times. Its output:\n${tail(read(`${P.logs}/gate.runner.log`) || '(empty)')}` }, skipped: [], flaky: [], log: `${P.logs}/${key}.log` };
      } else {
        fs.rmSync(RESULT, { force: true });
        const fd = fs.openSync(`${P.logs}/gate.runner.log`, 'a');
        const child = spawn(process.execPath, [SELF, '_run-gate', key], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
        child.on('exit', () => { exited = true; });
        child.unref();
        runner = child.pid;
      }
    }
    const deadline = Date.now() + wait * 1000;
    while (!res && Date.now() < deadline) {
      await delay(1000);
      let r = readJSON(RESULT);
      if (r && r.key === key) { res = r; break; }
      if (exited || !alive(runner)) {
        await delay(1500);
        r = readJSON(RESULT);
        if (r && r.key === key) { res = r; break; }
        out({ result: 'running', id: step.id, hint: `The check runner stopped early (see ${P.logs}/gate.runner.log). Run the same gate command again to restart it.` });
        return;
      }
    }
    if (!res) { out({ result: 'running', id: step.id, hint: `The checks are still running (log: ${P.logs}/${key}.log). Run the same gate command again; do nothing else in the meantime.` }); return; }
  }
  fs.rmSync(RESULT, { force: true });
  fs.rmSync(TRIES, { force: true });

  const x = st(s, step.id);
  c.idle = 0;
  if (res.skipped && res.skipped.length) x.skipped_checks = res.skipped;
  if (res.flaky && res.flaky.length) x.flaky_checks = [...new Set([...(x.flaky_checks || []), ...res.flaky])];
  if (!res.ok) { emit(failNow(res.failed.summary, res.log)); return; }

  if (c.phase === 'build' && step.review) {
    const prev = JSON.stringify(s);
    c.phase = 'review'; c.review_try = 1; c.issued = false;
    saveState(s);
    const r = commit(`${step.id}: ${step.title}`, plan);
    if (!r.ok) {
      const back = JSON.parse(prev);
      for (const k of Object.keys(s)) delete s[k];
      Object.assign(s, back);
      emit(fail(plan, s, step, `git commit was rejected:\n${r.error}`, null));
      return;
    }
    s.current.built = r.sha;
    saveState(s);
    emit({ result: 'pass', id: step.id, done: false, seconds: res.seconds, skipped_checks: res.skipped, flaky_checks: res.flaky, note: 'Built and committed. The review comes next.', push: push(s), then: `${ME} next` });
    return;
  }
  emit({ ...finalize(plan, s, step, c.phase === 'build' ? 'none' : 'applied'), seconds: res.seconds, skipped_checks: res.skipped, flaky_checks: res.flaky });
}

// ---------- commands: retry, block, pause, resume, status, settings, watchdog, finish, hook-stop ----------

function rescueContext(name) {
  const { plan, error } = loadPlan();
  if (!plan) die(error);
  const s = loadState() || die(`No ${P.state}.`);
  if (!s.current || s.current.phase !== 'rescue') die(`${name} is only for a step in rescue (see the "rescue" action from next).`);
  return { plan, s, step: plan.steps[stepIndex(plan, s.current.id)] };
}

function cmdRetry() {
  const { plan, s, step } = rescueContext('retry');
  const c = s.current;
  const x = st(s, step.id);
  if (c.rescue_reason !== 'blocked_report') die('retry is only offered when the builder reported BLOCKED. This step already ran on the strongest model: replan or block.');
  if (x.retried) die('This step has already had its retry: replan or block.');
  x.retried = true;
  c.phase = 'build'; c.top = true; c.attempt += 1; x.attempts = c.attempt; c.issued = false;
  delete c.rescue_reason;
  saveState(s);
  const up = ladder(plan, step, c.attempt, true);
  emit({ result: 'retrying', id: step.id, on: `${up.model}/${up.effort}`, then: `${ME} next` });
}

function cmdBlock(reason) {
  const { plan, s, step } = rescueContext('block');
  if (!str(reason)) die('Give a one-line reason: block <reason>');
  emit({ result: 'blocked', ...block(plan, s, step, reason.trim()) });
}

function cmdPause(reason, paused) {
  const s = loadState() || die(`No ${P.state}.`);
  if (s.status === 'finished') die('The run is finished.');
  if (!paused) fs.rmSync(`${P.logs}/hook.json`, { force: true });
  s.status = paused ? 'paused' : 'running';
  if (paused) s.reason = reason || 'paused'; else delete s.reason;
  saveState(s);
  out({ result: s.status, then: paused ? `${ME} resume` : `${ME} next` });
}

function cmdStatus(json) {
  const { plan, error } = loadPlan();
  if (!plan) die(error);
  const s = loadState() || { status: 'not started', steps: {}, current: null };
  const prog = counts(plan, s);
  if (json) { out({ status: s.status, reason: s.reason, progress: prog, current: s.current, steps: plan.steps.map((p) => ({ id: p.id, title: p.title, model: p.model, effort: p.effort, ...(s.steps[p.id] || { status: 'todo' }) })), last_failure: s.last_failure || null }); return; }
  console.log(`${plan.project}: ${s.status}${s.reason ? ` (${s.reason})` : ''} — ${prog.done}/${prog.total} done, ${prog.blocked} blocked, ${prog.skipped} skipped`);
  if (s.current) console.log(`Current: ${s.current.id} ${s.current.phase}, attempt ${s.current.attempt}`);
  for (const m of plan.milestones) {
    console.log(`\n${m.id} ${m.title}`);
    for (const p of plan.steps.filter((x) => x.milestone === m.id)) {
      const x = s.steps[p.id] || { status: 'todo' };
      const mark = { done: 'x', blocked: '!', skipped: '-', todo: ' ' }[x.status] || ' ';
      console.log(`  [${mark}] ${p.id.padEnd(6)} ${p.model}/${p.effort}`.padEnd(30) + ` ${p.title}${x.attempts > 1 ? ` (${x.attempts} attempts)` : ''}${x.review === 'dropped' ? ' (not reviewed)' : ''}${x.reason ? ` — ${x.reason}` : ''}`);
    }
  }
}

function cmdSettings() {
  const { plan } = loadPlan();
  const tool = plan && str(plan.verify) ? plan.verify.trim().split(/\s+/)[0] : null;
  const allow = [`Bash(${ME} *)`, 'Bash(git status *)', 'Bash(git diff *)', 'Bash(git log *)'];
  if (tool && /^[\w.-]+$/.test(tool)) allow.push(`Bash(${tool} *)`);
  // The hook does nothing once the run is finished, or if the autobuild folder is ever removed.
  const hook = `[ -f "$CLAUDE_PROJECT_DIR/${P.self}" ] && node "$CLAUDE_PROJECT_DIR/${P.self}" hook-stop || true`;
  out({ permissions: { allow }, hooks: { Stop: [{ hooks: [{ type: 'command', command: hook }] }] } });
}

function cmdWatchdog(id) {
  const s = loadState() || die(`No ${P.state}. Run init first.`);
  s.watchdog = !id || id === 'clear' ? null : id;
  saveState(s);
  out({ result: 'ok', watchdog: s.watchdog });
}

function cmdFinish() {
  const { plan, error } = loadPlan();
  if (!plan) die(error);
  const s = loadState() || die(`No ${P.state}.`);
  if (s.status !== 'finished') {
    if (s.current || pick(plan, s)) die('Steps remain. Run next.');
    s.status = 'finished'; s.finished_at = now();
    saveState(s);
    commit('autobuild: finished', plan);
  }
  const of = (f) => plan.steps.filter((p) => f(s.steps[p.id] || {}));
  const list = (status) => of((x) => x.status === status).map((p) => ({ id: p.id, title: p.title, reason: s.steps[p.id].reason }));
  out({
    result: 'finished', project: plan.project, progress: counts(plan, s),
    blocked: list('blocked'), skipped: list('skipped'),
    not_reviewed: of((x) => x.review === 'dropped').map((p) => p.id),
    live_checks_not_run: of((x) => (x.skipped_checks || []).length).map((p) => ({ id: p.id, checks: s.steps[p.id].skipped_checks })),
    flaky_checks: of((x) => (x.flaky_checks || []).length).map((p) => ({ id: p.id, checks: s.steps[p.id].flaky_checks })),
    kpis: plan.kpis, kpi_readings: readJSON(P.kpi) || `no ${P.kpi} was written`,
    push: push(s),
    still_to_do: [s.watchdog ? `Delete the scheduled check-in ${s.watchdog}.` : null, 'Open the pull request if the user chose one.', 'Give the final report.'].filter(Boolean),
  });
}

function cmdHookStop() {
  let input = {};
  try { if (!process.stdin.isTTY) input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { /* no input */ }
  const session = input && input.session_id ? String(input.session_id) : null;
  const s = loadState();
  if (!s || s.status !== 'running') process.exit(0);
  // After "no_work" the session is meant to stop and wait for the scheduled check-in.
  if (s.hold_at && Date.now() - Date.parse(s.hold_at) < HOLD_MS) process.exit(0);
  const { plan } = loadPlan();
  if (!plan || !Array.isArray(plan.steps)) process.exit(0);
  const prog = counts(plan, s);
  // Once an agent has been issued it is normally running in the background, and its
  // completion wakes the session, so stopping is right. A report on disk does not prove the
  // agent has finished: agents sometimes write it and keep working. Only Claude Code knows, so
  // the session is held only when it says that no background task is alive.
  const c = s.current;
  let reason = `The autobuild run is not finished: ${prog.done} of ${prog.total} steps done${prog.todo ? `, ${prog.todo} left` : ''}. Run "${ME} next" and continue as ${P.orch} describes. Do not wait for the user. To stop on purpose, run "${ME} pause <reason>" first.`;
  if (c && c.issued && c.phase !== 'rescue') {
    const bt = input ? input.background_tasks : undefined;
    const live = Array.isArray(bt) ? bt.length : bt && typeof bt === 'object' ? Object.keys(bt).length : bt ? 1 : 0;
    if (bt === undefined || live > 0) process.exit(0);
    const reported = read(c.phase === 'build' ? `${P.reports}/${c.id}.md` : `${P.reports}/${c.id}.review.md`) !== null;
    reason = reported
      ? `The agent for step ${c.id} has finished and reported, and the run is not finished. Run "${ME} gate --wait 540" and continue as ${P.orch} describes.`
      : `The autobuild run is waiting on step ${c.id}, but no agent is running for it. Run "${ME} next" and start the agent it describes.`;
  }
  const mark = `${prog.done}|${prog.blocked}|${prog.skipped}|${s.current ? gateKey(s.current) + (s.current.issued ? '+' : '-') : 'idle'}`;
  const file = `${P.logs}/hook.json`;
  const h = readJSON(file) || {};
  // The first session seen while the run is active owns it; other sessions on this repo are left alone.
  const owner = h.owner || session;
  if (h.owner && session && h.owner !== session) process.exit(0);
  const n = h.mark === mark ? (h.n || 0) + 1 : 1;
  try { writeJSON(file, { owner, mark, n, at: now() }); } catch { /* read-only tree */ }
  if (n > 3) process.exit(0); // no progress after three reminders: let the session stop
  out({ decision: 'block', reason });
}

// ---------- main ----------

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case 'validate': cmdValidate(); break;
  case 'init': cmdInit(); break;
  case 'replan': cmdReplan(); break;
  case 'next': cmdNext(); break;
  case 'gate': await cmdGate(args); break;
  case '_run-gate': await cmdRunGate(args[0]); break;
  case 'retry': cmdRetry(); break;
  case 'block': cmdBlock(args.join(' ')); break;
  case 'pause': cmdPause(args.join(' '), true); break;
  case 'resume': cmdPause('', false); break;
  case 'status': cmdStatus(args.includes('--json')); break;
  case 'settings': cmdSettings(); break;
  case 'watchdog': cmdWatchdog(args[0]); break;
  case 'finish': cmdFinish(); break;
  case 'hook-stop': cmdHookStop(); break;
  default:
    console.log(`Usage: ${ME} validate | init | next | gate [--wait N] | replan | retry | block "<reason>" | pause "<reason>" | resume | status [--json] | settings | watchdog <id>|clear | finish`);
    process.exit(cmd ? 1 : 0);
}
