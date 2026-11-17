# Build report

## What was built

- `src/slugify.js`: `slugify(text)` turns text into a URL slug. It throws a TypeError for non-strings, removes accents, lowercases, joins runs of non-alphanumeric characters with one hyphen, and trims edge hyphens.
- `test/slugify.test.js`: six tests covering case, accents, separators, edge trimming, empty input and type errors.
- `scripts/kpi.mjs`: measures K1 and writes `autobuild/kpi.json`.
- `README.md`: usage example for `slugify`.

## K1 reading

- K1, slug cases passing: 6 of 6 passing, value 1, target `>= 1`, pass `true`.
- Measured by running `node --test --test-reporter=tap test/slugify.test.js` and counting top-level `ok` and `not ok` lines.
- Run with `node scripts/kpi.mjs`. Result written to `autobuild/kpi.json`.

## Verification

- `npm run verify` exits 0 with all tests passing.
