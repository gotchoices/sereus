description: Deterministic strand selection on reference-app-rn chat screen
prereq:
files: packages/reference-app-rn/app/index.tsx, packages/reference-app-rn/src/cadre-context.tsx, packages/reference-app-rn/maestro/_setup.yaml, packages/reference-app-rn/maestro/_helpers/discover-phone-strand.js
----

## Problem

`app/index.tsx` line 23 picks the chat strand non-deterministically:

```ts
const firstStrand = cadre.strands.values().next().value ?? null;
```

When both the phone-created strand and the drone's pre-created strand are
present (a normal situation once `strandFilter: { mode: 'all' }` runs on
both sides — see `src/cadre-phone.ts:103` and
`test-fixture/start.mjs:70`), the chat shows whichever was inserted into
the Map first. Insertion order depends on a race between local
`createStrand` and inbound control-sync of the drone's strand.

In the e2e setup, the phone taps Connect → waits for the seed modal
exchange → only then taps Create Strand. By that point, control sync has
almost certainly pulled the drone's pre-created strand `STRAND_ID` first,
so the chat screen actually shows `STRAND_ID`, not the phone-created
strand. But `maestro/_helpers/discover-phone-strand.js` sets
`WORKING_STRAND_ID = (any strand on drone ≠ STRAND_ID)` — the
phone-created strand — and the drone-side helpers (`drone-insert.js`,
`drone-assert-phone-message.js`) target `WORKING_STRAND_ID`.

Net effect: phone is viewing strand B, drone is inserting into / asserting
against strand A. Flows 2 and 3 will silently miss each other's messages.

## Options

1. **Add a strand picker in the UI** — list `cadre.strands` and let the
   user (and Maestro) select one. Most flexible; matches plan-stage
   "pin a strand" suggestion. Adds testIDs per strand row.

2. **Drop "Create Strand" from the e2e flow** — use the drone's
   pre-created strand (`STRAND_ID`) directly. The phone joins it via
   `strandFilter:all`. `WORKING_STRAND_ID` becomes `STRAND_ID`. Simpler
   but loses coverage of the Create Strand button.

3. **Deterministic order at the cadre layer** — `strands` exposed in
   insertion order is OK; the real fix is to make `firstStrand` choose
   by a stable rule (e.g. lexicographic strand-id, or
   "most-recently-created locally", or last-active). This still requires
   `discover-phone-strand.js` to mirror that rule.

Recommended: (1) for the UX win plus test determinism, with (2) as the
quick fix if (1) is too much work.

## Acceptance

- Flows 2 and 3 reliably pass when the drone has both pre-created and
  phone-created strands present at the time of message insert/assert.
- No silent divergence between "strand the phone is showing" and "strand
  the drone targets".
