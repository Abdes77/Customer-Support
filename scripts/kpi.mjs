// Measures K1 (slug cases passing) by running test/slugify.test.js and
// writes the reading to autobuild/kpi.json.
// Usage: node scripts/kpi.mjs
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testFile = join('test', 'slugify.test.js');
const outFile = join(root, 'autobuild', 'kpi.json');

const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', testFile], {
  cwd: root,
  encoding: 'utf8',
});

if (run.error) {
  console.error(`K1: could not run node --test ${testFile}: ${run.error.message}`);
  process.exit(1);
}

// Count top-level TAP results only (subtests are indented).
let passing = 0;
let failing = 0;
for (const line of (run.stdout ?? '').split('\n')) {
  if (/^ok \d+/.test(line)) passing++;
  else if (/^not ok \d+/.test(line)) failing++;
}

const total = passing + failing;
const value = total === 0 ? 0 : passing / total;
const kpi = {
  K1: {
    value,
    target: '>= 1',
    pass: value >= 1,
  },
};

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(kpi, null, 2) + '\n');

console.log(`K1: ${passing} passing, ${failing} failing of ${total} (value ${value}, pass ${kpi.K1.pass})`);
