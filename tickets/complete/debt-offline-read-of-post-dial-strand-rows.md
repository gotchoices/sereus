description: A second machine is now proven to still answer questions about rows written after it joined a shared dataset, not only about the rows that existed when the dataset was first set up — with the first machine switched off.
files: packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, docs/cadre-consistency.md
----

## What landed

One new integration test proving the durability claim the ticket asked about, plus the
review pass's own fixes. Two files changed in total; no production code was touched.

**The test** — `serves a row written AFTER the catch-up from the joiner alone once the
founder stops`, in `strand-membership-closed-strand-e2e.integration.ts`, now the seventh
of nine in the first `describe`:

1. Brings up a two-node closed strand.
2. Waits for whole-store block coverage (founder ⊆ joiner) through the raw block stores
   only, never through the joiner's database — deliberately *before* any new write, so
   everything the one-shot peer-join catch-up sweep (`cadre-core/src/peer-join-backfill.ts`)
   was ever going to carry has already landed.
3. Writes on the founder only, after that moment: an invite issued, a member admitted
   through the real invite flow, and that member's signed `App.Items` insert. Four tables
   (`Strand.Invite`, `Strand.Member`, `Strand.ConsumedInvite`, `App.Items`), because the
   control-network failure this test exists to catch presented per collection.
4. Asserts those writes really produced blocks the sweep cannot have carried, then gates
   on exactly those blocks — narrowed by `newOrAdvancedSince` — reaching the joiner's own
   raw store.
5. Stops the founder and polls the joiner to zero strand connections.
6. Only then reads the joiner's database, and reads **row content**, re-asserting zero
   connections after the reads.

**The answer to the ticket's question: it passes.** Post-catch-up rows are durable and
readable on the joiner with the founder down. No defect found, so no `fix/` ticket.

## Review findings

**Verdict: the implementation is sound and its central claim holds.** The load-bearing
ordering argument was checked against the mechanism, not taken on the handoff's word: the
catch-up fires on `connection:open`, is debounced, and memoizes clean runs
(`peer-join-backfill.ts`), so on the stable connection this fixture holds it genuinely runs
once. Step 2's `newOrAdvancedSince` narrowing independently pins the same thing, and the
`include` predicate is applied against a fresh source index inside `compareBlockCoverage`,
so a block advanced after the baseline is correctly demanded at the newer revision. The
three post-catch-up rows are never read through `joinerDb` before the stop, so no read can
have pre-placed the bytes it later proves.

**Correctness / logic defects: none found.** Explicitly checked and clean — the anti-vacuity
narrowing, the raw-store-only discipline in steps 1 and 3, the `founderStopped` flag against
double-stop in `finally`, and the ordering of every `joinerDb` read relative to the writes.

**Fixed in this pass (minor):**

- **Stale ordinals in the file header.** The header's replication-gating paragraph still
  named "the third, fifth, seventh and eighth tests" — inserting the new test at position
  seven pushed the two seal tests to eighth and ninth. Corrected. The implement pass caught
  the other three ordinal references ("EIGHT"→"NINE", "six above"→"seven above", "eight
  passing"→"nine passing") but not this one.
- **`GATE`'s doc comment claimed "eight call sites"**; there are 24. Pre-existing drift, not
  introduced here, but a one-word fix in a file under review — the count is now unstated
  rather than wrong.
- **Verbatim duplication of the isolation proof across the two offline tests.** The
  zero-connection poll, its `GATE` description string and its log line were copied between
  the sixth and seventh tests. Extracted to `proveJoinerAlone(joinerStrand, label)`. The
  founder's `stop()` and the `founderStopped` assignment stay at the call site on purpose,
  since separating them by anything that can throw would let the `finally` stop an
  already-stopped node; the helper's doc says so.
- **A fourth collection was written but never read back.** `consumeInvite` writes a
  `Strand.ConsumedInvite` row in the same post-catch-up window, and the test's own stated
  rationale is that the control-side defect presented per collection. Added the offline
  read-back of that row's `MemberKey` via the scan-shaped `scanColumn`. Passing.
- **The scope limit was unstated, and here it is load-bearing.** The joiner receives these
  blocks at commit time only because it is in every block's cohort —
  `DEFAULT_STRAND_CLUSTER_SIZE` is 4 and this strand has two machines. Above that size a
  machine outside a block's cohort is neither written to at commit nor swept afterwards, so
  the result does not generalize. The file states such limits everywhere else; a
  "WHAT IS NOT CLAIMED" paragraph now says it and points at the existing ticket.
- **`docs/cadre-consistency.md` was out of date.** The implement pass declined to touch
  docs and asked the reviewer to rule. It is a real gap: that document already carries a
  paragraph recording the *sixth* test's result with measurements, and that paragraph is
  scoped explicitly and narrowly to the strand's *founding* rows, so as written it
  understates what is now proven. A sibling paragraph now records the ordinary-write
  result, its measurements, and the cohort-size limit above.

**Considered and NOT filed:**

- **File size — 1787 lines before this pass, 1811 after** (measured with `wc -l`); the
  largest scenario file in the package, ahead of `strand-formation-e2e` at 1741. The file
  already carries a `NOTE:` declining the harness hoist with a stated revisit condition — a
  *third* scenario file needing the harness — and that condition has not tripped. Per the
  accepted-tradeoff rule the decision stands; re-filing it would be re-discovering a call
  already made. Hoisting a ~400-line private harness with no second consumer is speculative
  generality, and the ~1390 lines that would remain is not a materially different number.
- **Durability above the strand cohort size** is genuinely unproven, and this test cannot
  speak to it. It is already owned by `backlog/debt-replication-proof-above-cohort-size`,
  whose `files:` header names this exact scenario file and whose body already states the
  four-and-under case. Evidence for an existing ticket, not a new one — recorded in the code
  comment instead.
- **`item!` after `toBeDefined()`.** The handoff invited a ruling. The shape is correct as
  written: if the row is missing the `toBeDefined()` fails first, so the assertion can never
  throw on null. No change.
- **The anti-vacuity floor of 4 against a measured 13.** Deliberately loose so the test does
  not pin the storage layout. Reasonable as written; a regression that halved the block count
  would indeed slip past it, but such a regression would fail the coverage gate on content
  bytes long before the floor mattered.

**Tripwires recorded: none.** Nothing in the diff is "fine now, only matters if X" — the one
conditional concern (behaviour above the cohort size) is a real unmeasured gap with a live
ticket, not a conditional one, so it was recorded as a code comment pointing at that ticket
rather than as a tripwire.

**New tickets filed: none.** No finding rose above minor, and every one was fixable in this
pass.

## How it was validated

| what | result |
| --- | --- |
| `yarn lint` | exit 0, before and after the review edits |
| `yarn workspace @serfab/integration-tests typecheck` | exit 0, before and after |
| `yarn build` (whole monorepo) | exit 0 |
| target file, whole-file runs | **9/9 passed**, three consecutive runs |
| whole integration suite (255 tests, 508 s) | 2 failed / 246 passed / 7 skipped — both failures pre-existing and already owned |

Measured and stable across all three runs: the founder holds **20** committed blocks when
the sweep completes and **29** after the post-sweep writes, of which **13** are
new-or-advanced; the joiner covers all 29. First post-stop read: 19, 23 and 68 ms.

The implement pass reported that four of the file's tests are intermittently red on
`blocked/strand-unique-index-sync-stale-revision`. Seven consecutive green whole-file runs
across the two passes now, with zero red. That is not evidence the flakiness is gone, only
that it has not surfaced on this fixture.

## Pre-existing failures in the full-suite run — none mine, none re-reported

No `.pre-existing-error.md` was written: both failures are already in
`tickets/.pre-existing-known.md` with live owners, at the exact fingerprints recorded there.

- `control-cohort-edge-carries-data` (1 test) — `Block default/Revocation is unavailable
  (cohort-unreachable)` on the carry step. Owned by
  `fix/control-peer-row-refresh-invisible-to-third-node` /
  `blocked/control-read-over-fresh-edge-stream-resets`.
- `control-cohort-three-node-isolation` (1 test) — `Timeout waiting for B resolves C's
  signed CadrePeer address record after 45000ms`, the recorded 45 s address-resolution
  boot race. Same owner.
- `control-write-degraded-cohort-member` reports a file-level failure with its 7 tests
  skipped: its `beforeAll` boot gate failed, which is the same known boot race. No test in
  it ran.

Neither touches the strand code path this ticket exercised, and the diff is one integration
test file plus one documentation paragraph.

**One note for whoever next tends the known-failures file, deliberately not acted on here.**
The implement pass observed `push-wake-e2e` → "delivers a wake to a NAT'd receiver over a
circuit-relay (signaling-first) dial" failing with a fingerprint (`Seed frame too short: 0
bytes, need >=4 for length prefix` out of `seed-bootstrap.ts:62`) that differs from the one
`.pre-existing-known.md` records for it. All four `push-wake-e2e` tests passed in this
review's full-suite run, so that drift was not reproduced here and the file was left
unedited — appending a fingerprint this pass did not observe would record hearsay. The test
is already owned by `blocked/block-held-by-only-one-machine-is-unreadable` and is documented
as intermittent, so nothing is untracked either way.

## What remains out of scope

Unchanged from the implement pass, and still deliberate:

- The founder is never restarted, so convergence-after-reconnect is untested here — the
  sixth test already declines that for the same reason, that it would blur what a red result
  means.
- Only the founder writes. A row authored on the *joiner* and read back after the *founder*
  stops is a different and easier claim, and was not added.
- The joiner is stopped but never restarted, so this proves an isolated node answers, not
  that it answers across a process restart. `control-offline-read-after-restart` covers that
  shape on the control side.
