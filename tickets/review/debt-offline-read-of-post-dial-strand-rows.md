description: A second machine can now be shown to still answer questions about rows written after it joined a shared dataset, not only about the rows that existed when the dataset was first set up — with the first machine switched off.
files: packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts
difficulty: medium
----

## What landed

One new test in the closed-strand end-to-end file, plus one small private helper and the
header-prose updates that keep the file's own description true.

**The new test** — `serves a row written AFTER the catch-up from the joiner alone once the
founder stops`, the seventh in the first `describe`, sitting directly after the existing
offline-durability test it extends:

1. Brings up the usual two-node closed strand via `bringUpClosedStrand('offline-post-join')`.
2. Waits for **whole-store block coverage** (founder ⊆ joiner) through the raw block stores
   only — never through the joiner's database. This is deliberately *before* any new write,
   so everything the one-shot peer-join catch-up sweep
   (`cadre-core/src/peer-join-backfill.ts`) was ever going to carry has already landed.
3. Writes on the founder **only**, after that moment: an invite issued, a member admitted
   through the real invite flow, and a signed `App.Items` insert by that new member. Three
   tables (`Strand.Invite`, `Strand.Member`, `App.Items`), because the control-network
   failure this test exists to catch presented per collection.
4. Asserts the writes really produced blocks the sweep cannot have carried (anti-vacuity),
   then gates on those blocks — narrowed by `newOrAdvancedSince` — reaching the joiner's
   own raw store. Raw store only again.
5. Stops the founder and polls the joiner's strand libp2p node to **zero** connections.
6. Only then reads `joinerDb`, and reads **row content**: `Name`, `Value`, `CreatedBy` of
   the new `App.Items` row, the new member key, the invite key, and — as a regression
   guard — the founding member/manager keys. Re-asserts zero connections *after* the reads.

**The helper** — `appItemRows(db)`, an unfiltered scan of `App.Items` returning
`{id, name, value, createdBy}`. It exists because `App.Items.Id` is a single-column primary
key, so a where-equality on it is a full-PK point lookup that can miss on a networked strand
(this file's own lookup-shape rule); a miss on the one read the test exists for would look
exactly like the silent empty-table defect being hunted. The keyed equality still runs, but
*after* the scan, as a second shape where a miss fails rather than passes.

**Header prose** — the file said "EIGHT independent tests"; it now says NINE and describes
the two offline-durability tests and how they differ. The seal `describe`'s note about
sharing harness "with the six above" / "eight passing network tests" was likewise bumped.

## The question the ticket asked, answered

**It passes.** The promotion note was right to say "do not assume it passes" — but on this
fixture, post-catch-up rows *are* durable and readable on the joiner with the founder down.
No defect found, so no `fix/` ticket. Measured, stable across every run: the founder holds
**20** committed blocks when the sweep completes and **29** after the post-sweep writes, of
which **13** are new-or-advanced; the joiner covers all 29; the first post-stop read takes
16–22 ms and returns the row.

## How it was validated

| what | result |
| --- | --- |
| `yarn lint` | exit 0 |
| `yarn workspace @serfab/integration-tests typecheck` | exit 0 |
| `yarn build` (whole monorepo) | exit 0 |
| target file, 4 consecutive whole-file runs | **9/9 passed every run** |
| whole integration suite (255 tests, 459 s) | 7 failed / 248 passed — all 7 pre-existing, see below |

The ticket flagged that four of the file's tests are intermittently red on
`blocked/strand-unique-index-sync-stale-revision`. **Zero red runs in four** — not evidence
the flakiness is gone, just that it did not surface here. The new test performs writes and
therefore carries the same exposure as its neighbours.

## Pre-existing failures in the full-suite run — none re-reported, none mine

No `.pre-existing-error.md` was written: every failure is already in
`tickets/.pre-existing-known.md` with a live owner.

- `control-write-degraded-cohort-member` (5 tests) — the half-applied-commit wedge, upstream
  `1-a-half-applied-commit-wedges-a-block-forever`.
- `control-cohort-edge-carries-data` (1 test) — the `cohort-unreachable` boot failure.
- `push-wake-e2e` → `delivers a wake to a NAT'd receiver over a circuit-relay
  (signaling-first) dial` (1 test) — listed as a known intermittent owned by
  `blocked/block-held-by-only-one-machine-is-unreadable`. **Worth a reviewer's eye: the
  fingerprint has moved again.** The known file records `UnsupportedListenAddressesError`,
  then `at rev 1` / a convergence timeout; this run died with `Seed frame too short: 0
  bytes, need ≥4 for length prefix` out of `seed-bootstrap.ts:62` on the relayed candidate
  address, then a 10 s dial timeout on the unreachable `10.255.0.1` fallback. Same test,
  same open owner, so it is not re-triaged here — but the recorded fingerprint is stale.

None of the three touch the strand code path this ticket exercised; the diff is one
integration test file.

## What a reviewer should push on

- **Does the test prove what its name says?** The load-bearing claim is that step 1's
  whole-store gate runs *before* the writes, so a pass cannot be credited to the catch-up
  sweep. Step 3's `newOrAdvancedSince` narrowing independently pins the same thing. If you
  think either is weaker than claimed, that is the finding.
- **The anti-vacuity floor is 4** against a measured 13. Generous on purpose (the storage
  layout is not being pinned), but a reviewer may reasonably argue it is too loose to catch
  a regression that halves the block count.
- **`App.Items` content assertions use `item!`** after a `toBeDefined()`. Vitest does not
  narrow from that, hence the non-null assertions; if the row is missing the `toBeDefined()`
  fails first, so the `!` can never actually throw. Flag it if you disagree with the shape.
- **The file is now 1787 lines and nine tests**, all sharing one private harness. The
  existing note says a third *scenario file* needing that harness should trigger a hoist to
  `src/harness/` under its own ticket; this ticket added a test, not a file, so no hoist was
  attempted. Reviewer may judge the file has crossed a size line anyway — measured with
  `wc -l`: 1598 before, 1787 after.
- **Nothing in `docs/` was updated.** The behaviour proven is not new behaviour, only newly
  proven; `docs/strands.md` describes the catch-up already. Say so if you think the
  durability guarantee for ordinary writes now deserves a sentence there.

## Not done / out of scope

- The founder is never restarted, and convergence-after-reconnect is untested here — the
  sixth test's comment already declines that for the same reason (it would blur what a red
  result means).
- Only the founder writes. A row authored on the *joiner* and read back after the *founder*
  stops is a different (and easier) claim and was not added.
- `tickets/.pre-existing-known.md` was not edited; the `push-wake-e2e` fingerprint drift is
  reported above rather than filed.
