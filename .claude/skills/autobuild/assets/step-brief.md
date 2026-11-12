# S07 · Lead scoring

## Outcome

After every customer turn the lead record holds, for each qualification criterion, its value,
a confidence and the sentence of the conversation it came from, and a score computed from the
weights in the settings. Later steps route on that score, so the same conversation and settings
must always give the same score.

## Read

- docs/ARCHITECTURE.md, sections "Lead model" and "Settings resolver"
- packages/core/src/lead.ts (the types this step fills in)
- packages/settings/src/resolve.ts (how to read weights and thresholds)

## Owns

- packages/scoring/src/**

## Do not change

- packages/scoring/test/** — the tests written in S06 are the specification for this step

## Interfaces

- Consumes: `resolveSettings(businessId)` and the `Lead` and `Turn` types from packages/core.
- Provides: `scoreLead(lead, settings): ScoredLead`, exactly as declared in
  docs/ARCHITECTURE.md, section "Lead model". S09 (routing) and S21 (admin lead list) call it.

## Done when

- `pnpm verify` exits 0
- `pnpm test --filter scoring` passes: every S06 test, unchanged (twelve varied leads across
  three settings profiles, each asserting the exact score)

## Out of scope

- The routing decision (S09) and the written lead report (S08).
- Any UI.
