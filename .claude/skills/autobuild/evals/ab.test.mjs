#!/usr/bin/env node
// End-to-end test for scripts/ab.mjs. Builds throwaway git repos, plays the part of the
// orchestrator and of the build agents, and checks every path of the state machine.
//
//   node evals/ab.test.mjs            (run from the skill folder)
//
// This folder is left out of the packaged .skill file; it is only for changing the script safely.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'scripts', 'ab.mjs');
const exists = (f) => `node -e "process.exit(require('fs').existsSync('${f}')?0:1)"`;
const VERIFY = `node -e "process.exit(require('fs').existsSync('broken.txt')?1:0)"`;

let dir;
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: dir, encoding: 'utf8', ...opts });
const git = (...a) => sh('git', a);
const ab = (...a) => {
  const r = sh('node', ['autobuild/ab.mjs', ...a]);
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* plain text */ }
  return { status: r.status, json, text: r.stdout + r.stderr };
};
const write = (f, text) => { fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); };
const readT = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const readJ = (f) => JSON.parse(readT(f));
const has = (f) => fs.existsSync(path.join(dir, f));
const dirty = () => git('status', '--porcelain').stdout.trim().split('\n').filter(Boolean).map((l) => l.trim().split(/\s+/)[1]).sort();

const OPUS = { model: 'opus', effort: 'high' };
const step = (id, o = {}) => ({
  id, title: `Step ${id}`, milestone: 'M1', kind: 'build', model: 'sonnet', effort: 'medium',
  why: 'test', depends_on: [], covers: ['R1'], checks: [exists(`${id}.txt`)], review: null, ...o,
});
const brief = (id) => `# ${id}\n\n## Outcome\nMake ${id}.txt.\n\n## Read\n- nothing\n\n## Done when\n- ${id}.txt exists\n`;

function project(steps, extra = {}) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-test-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.com');
  fs.mkdirSync(path.join(dir, 'autobuild'));
  fs.copyFileSync(SCRIPT, path.join(dir, 'autobuild', 'ab.mjs'));
  write('autobuild/RULES.md', '# rules\n'); write('autobuild/ORCHESTRATOR.md', '# orchestrator\n');
  const plan = {
    version: 1, project: 'test', branch: 'main', verify: VERIFY, models: ['haiku', 'sonnet', 'opus', 'fable'],
    requirements: { R1: 'it works' }, kpis: [{ id: 'K1', name: 'works', target: '100%', how: 'check', step: steps[steps.length - 1].id }],
    milestones: [{ id: 'M1', title: 'Only' }], steps, ...extra,
  };
  write('autobuild/plan.json', JSON.stringify(plan, null, 2));
  for (const s of steps) write(`autobuild/steps/${s.id}.md`, brief(s.id));
  return plan;
}
const savePlan = (plan) => write('autobuild/plan.json', JSON.stringify(plan, null, 2));

// Play a builder: optionally produce the file, always write the report.
const build = (id, { produce = true, status = 'STATUS: DONE' } = {}) => {
  if (produce) write(`${id}.txt`, 'ok\n');
  write(`autobuild/reports/${id}.md`, `${status}\n\nproof\n`);
};
const review = (id) => write(`autobuild/reports/${id}.review.md`, 'No changes needed.\n');
const gate = (...a) => ab('gate', '--wait', '60', ...a).json;
const next = () => ab('next').json;
const who = (a) => `${a.agent.model}/${a.agent.effort}`;

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { console.log(`FAIL ${name}\n     dir: ${dir}`); throw e; }
  fs.rmSync(dir, { recursive: true, force: true }); // keep the folder only when a test failed
};

// ----------------------------------- the plan check -----------------------------------------

test('validate rejects a broken plan and names every problem', () => {
  const plan = project([step('A1'), step('A2', { depends_on: ['A9'], model: 'haiku', checks: [], covers: [] }), step('A3', { model: 'gpt', effort: 'huge' })]);
  plan.requirements.R2 = 'never covered';
  plan.kpis.push({ id: 'K2', name: 'x', target: 'y', how: 'z' });
  savePlan(plan);
  fs.rmSync(path.join(dir, 'autobuild/steps/A3.md'));
  const r = ab('validate');
  assert.equal(r.status, 1);
  const all = r.json.errors.join('\n');
  for (const needle of ['depends_on "A9"', 'no always-run check of its own and no review', 'model must be one of', 'effort must be one of', 'A3.md is missing', 'requirement R2', 'kpi K2']) assert.ok(all.includes(needle), `missing error: ${needle}\n${all}`);
});

test('validate accepts a good plan and warns about weak spots', () => {
  project([step('A1', { review: { model: 'haiku', effort: 'low' } }), step('A2', { depends_on: ['A1'] }), step('A3', { depends_on: ['A2'] }), step('A4', { model: 'fable', effort: 'high', review: OPUS })]);
  const r = ab('validate');
  assert.equal(r.status, 0, r.text);
  assert.equal(r.json.result, 'valid');
  const w = r.json.warnings.join('\n');
  assert.ok(w.includes('step A1: the reviewer (haiku) is a weaker model'));
  assert.ok(!w.includes('step A4'), 'opus reviewing fable is the standard and must not warn');
  assert.ok(w.includes('no step of kind "harden"'));
  assert.ok(w.includes('has 4 steps but no "integrate" step'));
});

test('every step needs something that would catch a wrong result', () => {
  const live = { cmd: 'exit 1', needs_env: ['SOME_KEY'] };
  project([
    step('A1', { model: 'opus', effort: 'high', checks: [], skip_verify: true }),
    step('A2', { model: 'opus', effort: 'high', checks: [live] }),
    step('A3', { model: 'haiku', effort: 'low' }),
    step('A4', { model: 'opus', effort: 'high', checks: [live] }),
  ], { verify_from: 'A3' });
  const all = ab('validate').json.errors.join('\n');
  assert.ok(all.includes('step A1: nothing would check this step'), all);
  assert.ok(all.includes('step A2: nothing would check this step'), `a live-only check before verify exists is not a safeguard\n${all}`);
  assert.ok(all.includes('step A3: this step creates the verify command'), all);
  assert.ok(!all.includes('step A4'), `verify covers A4\n${all}`);
});

test('fable at xhigh needs a written reason, max is refused, and retries never add effort to it', () => {
  const plan = project([
    step('A1', { model: 'fable', effort: 'xhigh' }),
    step('A2', { model: 'fable', effort: 'max' }),
    step('A3', { model: 'opus', effort: 'high', review: { model: 'fable', effort: 'xhigh' } }),
  ]);
  let r = ab('validate');
  assert.equal(r.status, 1);
  const all = r.json.errors.join('\n');
  for (const needle of ['A1: fable at xhigh needs "xhigh_reason"', 'A2: fable at max is not allowed', 'A3: a review on fable runs at high at most']) assert.ok(all.includes(needle), `missing error: ${needle}\n${all}`);
  plan.steps = [step('A1', { model: 'fable', effort: 'xhigh', xhigh_reason: 'fixes the contracts everything else builds on', kind: 'design' }), step('A2', { model: 'fable', effort: 'high' })];
  plan.kpis[0].step = 'A2';
  savePlan(plan);
  r = ab('validate');
  assert.equal(r.status, 0, r.text);
  assert.deepEqual(r.json.fable_at_xhigh.map((s) => s.id), ['A1']);
  ab('init');
  next(); build('A1'); gate();
  const seen = [];
  for (let i = 1; i <= 4; i++) { seen.push(who(next())); build('A2', { produce: false }); gate(); }
  assert.deepEqual(seen, ['fable/high', 'fable/high', 'fable/high', 'fable/high']);
});

test('a step planned on opus at xhigh never climbs to fable at xhigh', () => {
  project([step('A1', { model: 'opus', effort: 'xhigh' })]);
  ab('init');
  const seen = [];
  for (let i = 1; i <= 4; i++) { seen.push(who(next())); build('A1', { produce: false }); gate(); }
  assert.deepEqual(seen, ['opus/xhigh', 'opus/xhigh', 'fable/high', 'fable/high']);
});

// ----------------------------------- the normal path ----------------------------------------

test('init refuses the wrong branch, then creates state and commits', () => {
  const plan = project([step('A1')]);
  savePlan({ ...plan, branch: 'other' });
  assert.equal(ab('init').status, 1);
  savePlan(plan);
  const r = ab('init');
  assert.equal(r.json.result, 'ready', r.text);
  assert.equal(readJ('autobuild/state.json').status, 'running');
  assert.ok(readT('.gitignore').includes('autobuild/logs/'));
  assert.deepEqual(dirty(), []);
});

test('a step without review: build, gate, done, committed', () => {
  project([step('A1', { model: 'haiku', effort: 'low' })]);
  ab('init');
  const a = next();
  assert.equal(a.action, 'build');
  assert.deepEqual([who(a), a.attempt], ['haiku/low', 1]);
  assert.ok(a.agent.prompt.includes('autobuild/steps/A1.md'));
  build('A1');
  const g = gate();
  assert.equal(g.result, 'pass', JSON.stringify(g));
  assert.equal(g.done, true);
  assert.equal(readJ('autobuild/state.json').steps.A1.status, 'done');
  assert.ok(git('log', '--oneline').stdout.includes('A1: Step A1'));
  assert.deepEqual(dirty(), []);
  assert.equal(next().action, 'finish');
});

test('gate before next is refused, and next is idempotent', () => {
  project([step('A1'), step('A2', { depends_on: ['A1'] })]);
  ab('init');
  assert.equal(ab('gate').status, 1);
  const a = next();
  const b = next();
  assert.equal(b.attempt, a.attempt);
  assert.ok(b.note.includes('has not reported'));
  build('A1');
  assert.ok(next().note.includes('run gate'));
  assert.equal(gate().result, 'pass');
  assert.equal(ab('gate').status, 1, 'a second gate must not gate the next step unissued');
});

test('next and gate refuse to work on the wrong branch', () => {
  project([step('A1')]);
  ab('init'); next();
  git('checkout', '-q', '-b', 'elsewhere');
  assert.equal(next().action, 'wrong_branch');
  assert.equal(ab('gate').status, 1);
  git('checkout', '-q', 'main');
  assert.equal(next().action, 'build');
});

test('a step with review goes build → review → done', () => {
  project([step('A1', { review: OPUS })]);
  ab('init');
  next(); build('A1');
  const g1 = gate();
  assert.deepEqual([g1.result, g1.done], ['pass', false]);
  assert.equal(ab('gate').status, 1, 'the review gate needs the review to be issued first');
  const r = next();
  assert.deepEqual([r.action, r.review_try, who(r)], ['review', 1, 'opus/high']);
  assert.ok(/git diff [0-9a-f]{40} [0-9a-f]{40}/.test(r.agent.prompt), r.agent.prompt);
  review('A1'); write('extra.txt', 'review fix\n');
  const g2 = gate();
  assert.deepEqual([g2.result, g2.done, g2.review], ['pass', true, 'applied']);
  assert.ok(git('log', '--oneline').stdout.includes('A1: review'));
  assert.ok(git('ls-files').stdout.includes('extra.txt'));
});

// ----------------------------------- agents that do nothing ---------------------------------

test('an agent that changed nothing costs no attempt, and the stop hook lets the session rest', () => {
  project([step('A1', { review: OPUS })]);
  ab('init');
  const hook = () => sh('node', ['autobuild/ab.mjs', 'hook-stop'], { input: JSON.stringify({ session_id: 's1' }) }).stdout;
  next();
  assert.ok(hook().includes('"decision": "block"'));
  const g = gate();
  assert.deepEqual([g.result, g.count], ['no_work', 1], JSON.stringify(g));
  assert.equal(hook(), '', 'after no_work the session may stop and wait for the check-in');
  const again = next();
  assert.equal(again.attempt, 1, 'no attempt was used');
  assert.ok(hook().includes('"decision": "block"'), 'next ends the hold');
  build('A1'); assert.equal(gate().result, 'pass');
  next();
  assert.equal(gate().result, 'no_work', 'the same holds for a reviewer');
  assert.equal(next().review_try, 1);
  review('A1');
  assert.equal(gate().done, true);
});

test('three starts with no work at all do count as one failed attempt', () => {
  project([step('A1')]);
  ab('init');
  next(); assert.equal(gate().result, 'no_work');
  next(); assert.equal(gate().result, 'no_work');
  next();
  const g = gate();
  assert.equal(g.result, 'fail');
  assert.ok(g.summary.includes('three times'));
  assert.equal(next().attempt, 2);
});

test('work without a report is a failed attempt, not "no work"', () => {
  project([step('A1')]);
  ab('init'); next();
  write('A1.txt', 'ok\n');
  const g = gate();
  assert.equal(g.result, 'fail');
  assert.ok(g.summary.includes('wrote no report'));
});

// ----------------------------------- reviews that go wrong ----------------------------------

test('a review with no report is repeated with an honest prompt', () => {
  project([step('A1', { review: OPUS })]);
  ab('init');
  next(); build('A1'); gate();
  next(); write('half.txt', 'changed something\n');
  const g = gate();
  assert.equal(g.result, 'fail');
  assert.ok(g.summary.includes('wrote no report'));
  const r = next();
  assert.equal(r.review_try, 2);
  assert.ok(r.agent.prompt.includes('ended without writing its report'), r.agent.prompt);
  assert.ok(!r.agent.prompt.includes('checks now fail'));
  review('A1');
  assert.equal(gate().review, 'applied');
});

test('a review that breaks the checks: repair, then a fresh review on the strongest model', () => {
  project([step('A1', { review: OPUS }), step('A2', { depends_on: ['A1'] })]);
  ab('init');
  next(); build('A1'); gate();
  next(); review('A1'); write('broken.txt', 'oops\n');
  assert.equal(gate().result, 'fail');
  const r2 = next();
  assert.equal(r2.review_try, 2);
  assert.ok(r2.agent.prompt.includes('checks now fail'));
  review('A1');
  const g2 = gate();
  assert.equal(g2.result, 'fail');
  assert.ok(!has('broken.txt'), 'the review changes are out of the tree');
  assert.ok(readT('autobuild/failed/A1.review2.patch').includes('broken.txt'));
  const r3 = next();
  assert.deepEqual([r3.review_try, who(r3)], [3, 'fable/high']);
  assert.ok(r3.agent.prompt.includes('from scratch'));
  review('A1');
  const g3 = gate();
  assert.deepEqual([g3.result, g3.done, g3.review], ['pass', true, 'applied'], JSON.stringify(g3));
  assert.equal(next().id, 'A2');
});

test('three failed reviews keep the build and say so in the final summary', () => {
  project([step('A1', { review: OPUS })]);
  ab('init');
  next(); build('A1'); gate();
  let g;
  for (let i = 1; i <= 3; i++) { assert.equal(next().review_try, i); review('A1'); write('broken.txt', 'oops\n'); g = gate(); }
  assert.deepEqual([g.result, g.done, g.review], ['pass', true, 'dropped'], JSON.stringify(g));
  assert.ok(!has('broken.txt'));
  assert.equal(next().action, 'finish');
  assert.deepEqual(ab('finish').json.not_reviewed, ['A1']);
});

// ----------------------------------- failures, rescue, blocking -----------------------------

test('failures climb the ladder, then rescue, then block skips dependents', () => {
  project([
    step('A1', { model: 'haiku', effort: 'low' }),
    step('A2', { depends_on: ['A1'] }), step('A3', { depends_on: ['A2'] }), step('A4', { depends_on: [] }),
  ]);
  ab('init');
  const seen = [];
  for (let i = 1; i <= 4; i++) {
    const a = next();
    assert.equal(a.attempt, i);
    seen.push(who(a));
    if (i > 1) assert.ok(a.agent.prompt.includes('What went wrong last time'), a.agent.prompt);
    build('A1', { produce: false });
    write('partial.txt', `attempt ${i}\n`);
    const g = gate();
    assert.equal(g.result, 'fail');
    assert.ok(g.summary.includes('exited with code 1'));
    if (i === 4) assert.equal(g.rescue, true);
  }
  assert.deepEqual(seen, ['haiku/low', 'haiku/medium', 'sonnet/high', 'fable/high'], 'retries never raise effort above high');
  const r = next();
  assert.equal(r.action, 'rescue');
  assert.equal(r.choose_one.length, 2, 'no retry after the strongest model already failed');
  assert.ok(has('partial.txt'), 'partial work stays until the orchestrator decides');
  assert.equal(ab('gate').status, 1);
  assert.equal(ab('retry').status, 1);
  assert.equal(ab('block').status, 1, 'block needs a reason');
  const b = ab('block', 'cannot be built').json;
  assert.equal(b.result, 'blocked');
  assert.deepEqual(b.also_skipped, ['A2', 'A3']);
  assert.ok(!has('partial.txt'));
  assert.ok(readT('autobuild/failed/A1.patch').includes('partial.txt'), 'the partial work is kept as a patch');
  assert.ok(git('ls-files').stdout.includes('autobuild/failed/A1.patch'), 'and committed');
  assert.ok(has('autobuild/reports/A1.md'), 'the report stays readable');
  const todo = readT('docs/HUMAN_TODO.md');
  assert.ok(todo.includes('step A1') && todo.includes('autobuild/failed/A1.patch'), todo);
  assert.deepEqual(dirty(), []);
  const after = next();
  assert.deepEqual([after.action, after.id], ['build', 'A4']);
  build('A4'); assert.equal(gate().result, 'pass');
  assert.equal(next().action, 'finish');
  const f = ab('finish').json;
  assert.equal(f.result, 'finished');
  assert.deepEqual(f.blocked.map((x) => x.id), ['A1']);
  assert.deepEqual(f.skipped.map((x) => x.id), ['A2', 'A3']);
  assert.equal(next().action, 'finished');
});

test('rescue by replanning: replacements run, and are blocked without a second rescue', () => {
  const plan = project([step('A1'), step('A2', { depends_on: ['A1'] })], { max_attempts: 1 });
  ab('init');
  next(); build('A1', { produce: false }); write('partial.txt', 'x\n');
  assert.equal(gate().rescue, true);
  assert.equal(next().action, 'rescue');
  plan.steps = [step('A1a'), step('A1b', { depends_on: ['A1a'] }), step('A2', { depends_on: ['A1b'] })];
  savePlan(plan);
  assert.equal(ab('replan').status, 1, 'briefs for the new steps are required');
  write('autobuild/steps/A1a.md', brief('A1a')); write('autobuild/steps/A1b.md', brief('A1b'));
  const rp = ab('replan').json;
  assert.deepEqual(rp.new_steps, ['A1a', 'A1b']);
  assert.ok(!has('partial.txt') && has('autobuild/failed/A1.patch'), 'replan clears the failed work but keeps the new plan');
  assert.equal(readJ('autobuild/plan.json').steps.length, 3);
  assert.deepEqual(dirty(), []);
  assert.equal(next().id, 'A1a'); build('A1a'); assert.equal(gate().result, 'pass');
  assert.equal(next().id, 'A1b'); build('A1b', { produce: false });
  const g = gate();
  assert.equal(g.blocked, true, JSON.stringify(g));
  assert.deepEqual(g.also_skipped, ['A2']);
  assert.equal(next().action, 'finish');
});

test('a builder that reports BLOCKED goes straight to rescue; retry gives one top-model attempt', () => {
  project([step('A1', { model: 'sonnet', effort: 'medium' }), step('A2', { depends_on: ['A1'] })]);
  ab('init'); next();
  build('A1', { produce: false, status: 'STATUS: BLOCKED' });
  const g = gate();
  assert.deepEqual([g.result, g.rescue], ['fail', true]);
  assert.ok(g.summary.includes('STATUS: BLOCKED'));
  const r = next();
  assert.equal(r.action, 'rescue');
  assert.equal(r.choose_one.length, 3);
  assert.ok(r.choose_one[0].startsWith('Retry'));
  assert.equal(ab('retry').json.on, 'fable/high');
  const a = next();
  assert.deepEqual([a.action, who(a), a.attempt], ['build', 'fable/high', 2]);
  assert.ok(a.agent.prompt.includes('STATUS: BLOCKED'));
  build('A1', { produce: false, status: 'STATUS: BLOCKED' });
  const g2 = gate();
  assert.equal(g2.blocked, true, JSON.stringify(g2));
  assert.deepEqual(g2.also_skipped, ['A2']);
  assert.equal(next().action, 'finish');
});

// ----------------------------------- safety nets --------------------------------------------

test('a builder that edits the plan or the state is caught and undone', () => {
  project([step('A1'), step('A2', { depends_on: ['A1'] })]);
  ab('init');
  next();
  const before = readT('autobuild/plan.json');
  write('autobuild/plan.json', before.replace('"sonnet"', '"haiku"'));
  write('autobuild/steps/A2.md', 'tampered\n');
  const forged = readJ('autobuild/state.json'); forged.steps.A2 = { status: 'done' };
  write('autobuild/state.json', JSON.stringify(forged));
  build('A1');
  const g = gate();
  assert.equal(g.result, 'fail');
  assert.ok(g.summary.includes('must not touch'));
  assert.equal(readT('autobuild/plan.json'), before);
  assert.ok(readT('autobuild/steps/A2.md').includes('Done when'));
  assert.notEqual((readJ('autobuild/state.json').steps.A2 || {}).status, 'done', 'the forged status must be undone');
  assert.equal(next().attempt, 2);
});

test('the orchestrator may edit the plan between steps without tripping the guard', () => {
  const plan = project([step('A1', { kind: 'integrate' }), step('A2', { depends_on: ['A1'] })]);
  ab('init'); next(); build('A1');
  assert.ok(gate().milestone_closed.includes('Plan changes needed'));
  plan.steps[1].title = 'Step A2, corrected';
  savePlan(plan);
  write('autobuild/steps/A2.md', brief('A2') + '- and one more thing\n');
  assert.equal(ab('gate').status, 1, 'a stray gate changes nothing');
  assert.equal(readJ('autobuild/plan.json').steps[1].title, 'Step A2, corrected');
  assert.equal(ab('replan').json.result, 'replanned');
  assert.equal(next().title, 'Step A2, corrected');
});

test('legitimate state writes during a step do not trip the guard', () => {
  project([step('A1')]);
  ab('init');
  next();
  assert.equal(ab('watchdog', 'trig_123').json.watchdog, 'trig_123');
  build('A1');
  assert.equal(gate().result, 'pass');
  assert.equal(readJ('autobuild/state.json').watchdog, 'trig_123');
  assert.ok(ab('finish').json.still_to_do[0].includes('trig_123'));
});

test('slow checks: gate returns "running" and a second call collects the result', () => {
  project([step('A1', { checks: [`node -e "setTimeout(()=>{},7000)"`, exists('A1.txt')] })]);
  ab('init'); next(); build('A1');
  const g1 = ab('gate', '--wait', '5').json;
  assert.equal(g1.result, 'running');
  const g2 = gate();
  assert.equal(g2.result, 'pass', JSON.stringify(g2));
  assert.ok(g2.seconds >= 6);
});

test('a check that exceeds its timeout fails, without a rerun', () => {
  project([step('A1', { checks: [{ cmd: `node -e "setTimeout(()=>{},20000)"`, timeout_s: 2 }] })]);
  ab('init'); next(); build('A1');
  const g = gate();
  assert.equal(g.result, 'fail');
  assert.ok(g.summary.includes('timed out after 2s'), g.summary);
});

test('a flaky check is rerun once and reported, not charged as a failed attempt', () => {
  const flaky = `node -e "const fs=require('fs');if(fs.existsSync('.seen')){process.exit(0)}fs.writeFileSync('.seen','');process.exit(1)"`;
  project([step('A1', { checks: [flaky] })]);
  ab('init'); next(); build('A1');
  const g = gate();
  assert.equal(g.result, 'pass', JSON.stringify(g));
  assert.equal(g.flaky_checks.length, 1);
  assert.equal(ab('finish').json.flaky_checks[0].id, 'A1');
});

test('checks that need a missing variable are skipped and reported', () => {
  project([step('A1', { checks: [exists('A1.txt'), { cmd: 'exit 1', needs_env: ['AB_TEST_SURELY_MISSING'] }] })]);
  ab('init'); next(); build('A1');
  const g = gate();
  assert.equal(g.result, 'pass');
  assert.equal(g.skipped_checks[0].missing[0], 'AB_TEST_SURELY_MISSING');
  assert.equal(ab('finish').json.live_checks_not_run[0].id, 'A1');
});

test('verify is not run before the step that creates it', () => {
  project([step('A1'), step('A2', { depends_on: ['A1'], review: OPUS })], { verify: 'exit 1', verify_from: 'A2' });
  ab('init'); next(); build('A1');
  assert.equal(gate().result, 'pass');
  next(); build('A2');
  assert.equal(gate().result, 'fail');
});

test('a rejected commit counts as a failed check', () => {
  project([step('A1')]);
  ab('init');
  write('.git/hooks/pre-commit', '#!/bin/sh\necho "lint failed" >&2\nexit 1\n');
  fs.chmodSync(path.join(dir, '.git/hooks/pre-commit'), 0o755);
  next(); build('A1');
  const g = gate();
  assert.equal(g.result, 'fail');
  assert.ok(g.summary.includes('git commit was rejected'), g.summary);
  assert.equal(readJ('autobuild/state.json').current.attempt, 2);
});

// ----------------------------------- the rest -----------------------------------------------

test('pause stops the run, resume continues it', () => {
  project([step('A1')]);
  ab('init');
  ab('pause', 'user asked');
  assert.equal(next().action, 'paused');
  ab('resume');
  assert.equal(next().action, 'build');
});

test('stop hook holds the owning session while steps remain, with a release valve', () => {
  project([step('A1')]);
  const hook = (session) => sh('node', ['autobuild/ab.mjs', 'hook-stop'], { input: JSON.stringify({ session_id: session, stop_hook_active: false }) });
  assert.equal(hook('s1').stdout, '', 'no state yet: silent');
  ab('init');
  const first = JSON.parse(hook('s1').stdout);
  assert.equal(first.decision, 'block');
  assert.ok(first.reason.includes('next'));
  assert.equal(hook('s2').stdout, '', 'another session is left alone');
  hook('s1'); hook('s1');
  assert.equal(hook('s1').stdout, '', 'released after three reminders without progress');
  next();
  assert.equal(JSON.parse(hook('s1').stdout).decision, 'block', 'progress re-arms the hook');
  ab('pause', 'x');
  assert.equal(hook('s1').stdout, '');
  ab('resume');
  build('A1'); gate(); ab('finish');
  assert.equal(hook('s1').stdout, '', 'finished: silent');
});

test('settings prints allow rules and a stop hook that is harmless without the script', () => {
  project([step('A1')], { verify: 'pnpm verify' });
  const s = ab('settings').json;
  assert.ok(s.permissions.allow.includes('Bash(pnpm *)'));
  const command = s.hooks.Stop[0].hooks[0].command;
  assert.ok(command.includes('hook-stop'));
  const gone = spawnSync('sh', ['-c', command], { cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '/nonexistent' } });
  assert.deepEqual([gone.status, gone.stdout], [0, '']);
  ab('init');
  assert.ok(ab('status').text.includes('[ ] A1'));
  assert.equal(ab('status', '--json').json.progress.total, 1);
});

test('works outside git', () => {
  project([step('A1')]);
  fs.rmSync(path.join(dir, '.git'), { recursive: true });
  assert.equal(ab('init').json.result, 'ready');
  next(); build('A1');
  assert.equal(gate().result, 'pass');
});

console.log(`\n${passed} tests passed`);
