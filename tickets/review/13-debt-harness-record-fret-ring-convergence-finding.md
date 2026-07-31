description: Fixed a wrong comment in the test setup code that claimed test machines never discover each other — measurement showed they do, within ~5 seconds — and added a note about a real permanent limit in the star-shaped test topology.
prereq:
files: packages/integration-tests/src/harness/test-party.ts
difficulty: easy
----

# Record measured FRET ring-convergence finding; fix stale harness comment

Comment-only change, no behavior change. Replaces
`debt-harness-control-cohort-diagnose-empty-fret-ring` (deleted) — that ticket's
diagnosis question is answered; see its full writeup in
`tickets/implement/13-debt-harness-record-fret-ring-convergence-finding.md` history
(git log) for the measured table and reasoning. Summary of the finding:

- **Refuted**: peers that only ever get dialed *into* a node do join that node's FRET
  ring — measured within ~5s of `createTestParty` resolving, over real libp2p/TCP.
  What earlier looked like "cohort never grows" was a start-up race: writes issued
  before the ring warms see a self-only cohort.
- **Real, permanent limit**: in the star topology `createTestParty` builds, drones only
  dial the owner, never each other, so each drone's cohort caps at 2 (self + owner)
  forever. Only the owner ever sees all party members.

## What changed

`packages/integration-tests/src/harness/test-party.ts`:
- Replaced the stale `NOTE:` inside `createTestNode`'s `clusterPolicy` comment
  (previously ~lines 56–60). Old text asserted FRET returns no non-self candidates
  within a test's lifetime and cited a now-deleted ticket
  (`backlog/debt-harness-control-cohort-never-multi-peer`). New text states the
  measured ~5s convergence, the self-only-cohort race for writes issued before that,
  and points at `debt-harness-control-cohort-observable-and-forced` for the wait
  helper.
- Added a new short `NOTE:` at the drone-creation loop in `createTestParty` recording
  the permanent 2-member cohort cap for drones (star topology, no drone↔drone links).
- Left the rest of the surrounding comment (why `clusterPolicy`/`clusterSize` are
  shared with production) untouched, as instructed.

## Validation performed

- `yarn workspace @serfab/integration-tests typecheck` — clean (exit 0).
- `yarn eslint packages/integration-tests/src/harness/test-party.ts` — clean (exit 0).
- No test changes made or required — comment-only diff, per ticket instructions.
- Did not re-run the scratch convergence measurement; the numbers were produced and
  recorded by the prior (now-deleted) ticket, this ticket only relocates them into a
  durable comment.

## For the reviewer

- Verify the new `NOTE:` blocks read correctly in context (nothing else in the
  surrounding comment was touched) — `packages/integration-tests/src/harness/test-party.ts:48-62`
  and `:122-128`.
- Check no other file in the repo still references the deleted ticket slug
  `debt-harness-control-cohort-never-multi-peer` or
  `debt-harness-control-cohort-diagnose-empty-fret-ring` (a stale cross-reference
  would mislead the same way the original comment did). Not exhaustively grepped
  beyond the harness file itself.
- `debt-harness-control-cohort-observable-and-forced` (sequence 13.5) depends on this
  finding (stopgap vs. permanent forcing) — confirm its ticket text still lines up
  with what's recorded here once it lands.
