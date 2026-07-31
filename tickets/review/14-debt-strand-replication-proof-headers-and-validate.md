description: A test that proves one machine physically holds a copy of another's data was written but never run; it has now been run, and it revealed that data written before a second machine joins is never copied to it, so the test's claim was narrowed to what actually holds and the gap was filed separately.
prereq:
files: packages/integration-tests/src/harness/block-store-probe.ts, packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, packages/integration-tests/src/scenarios/rbac-signed-write.integration.ts, docs/cadre-consistency.md, tickets/backlog/debt-strand-no-backfill-of-pre-membership-blocks.md
difficulty: medium
----

Phases 4–5 of `debt-strand-replication-vs-visibility-proof`. The physical-replication test
landed in the prior ticket but had never been executed; this pass ran it, resolved what it
turned up, and replaced the stale comments that still pointed at the parked backlog slug.

## The headline: the assertion WAS narrowed, deliberately

On its first run the test failed exactly the way the ticket predicted. Diagnostics
(temporary logging, since removed) gave the real shape:

| moment | founder store | joiner store |
| --- | --- | --- |
| dial completes | 18 blocks | 7 blocks |
| after founder-only writes | 27 blocks | 23 blocks |

- Of the 13 blocks the founder gained (9 new) or advanced to a higher revision (4), **all
  13 were already in the joiner's own raw store on the first poll — 1 ms after the last
  write returned.** Ongoing physical replication works and is part of the commit.
- The 9 blocks that never arrived were **all committed before the dial**: the founder's
  bootstrap `Header`/`Member`/`Manager` data + index blocks, written to a cohort of one.
  Two of those 9 are node-local root blocks carrying a *different block id on each node*,
  so they could never match by construction — a whole-store subset claim was never a
  correct property to want, independent of the backfill gap.

Per the ticket's instructions the comparison was **narrowed, not loosened**: coverage is
now required only for blocks new-or-advanced since a baseline snapshot taken right after
bring-up. Post-dial authored blocks are still fully proven. The claim is stated in the
test's new `WHAT IS AND IS NOT CLAIMED` comment with the observed numbers, and explicitly
tells a future reader not to widen it back.

No `bug-` ticket: post-dial replication is healthy, which is the condition the source
ticket set for filing one. The pre-dial gap went to
`backlog/debt-strand-no-backfill-of-pre-membership-blocks` instead, with the measurement,
the durability consequence (founder offline → joiner holds no copy of the strand's founding
membership rows), and the observation that the control DB already has the analogous
mechanism (`CadreNode.drainPendingControlReplication`) while strands do not.

## What changed

**`harness/block-store-probe.ts`**
- `compareBlockCoverage(source, target, options?)` gained an optional
  `include?: (blockId, sourceRev) => boolean` predicate. Omitted → previous behaviour
  exactly (every source block must be covered).
- New `newOrAdvancedSince(baseline)` returns such a predicate. Small, pure, no I/O.

**`strand-membership-closed-strand-e2e.integration.ts`**
- Fourth test: baseline snapshot + narrowed coverage gate; anti-vacuity floor changed from
  "founder holds ≥ 2 blocks" to "≥ 6 blocks were authored-or-advanced since the dial"
  (observed 13) plus a retained `baseline.size >= 2` floor (observed 18). The log line now
  reports both totals and the post-dial count.
- File header: the `VISIBILITY IS NOT PHYSICAL REPLICATION` paragraph keeps the visibility
  caveat (still true, and still what the first three tests assert) but now points at the
  fourth test instead of the parked backlog slug.
- `requireJoinerAgrees` inline caveat: same redirect.

**`rbac-signed-write.integration.ts`** — comment + log line only, no behavioural change.
Both of its claims were checked against reality:
- The forward-referenced ticket `2-integration-tests-real-control-sync-and-scenario-honesty`
  **did land** (`31dbf16` implement, `ca19523` review) and was later removed from
  `tickets/complete/` by the routine 30-day prune (`905e057`) — which is why it is not on
  disk. It never touched this file and never addressed strand mode, so the "owned by
  ticket 2" pointer was doubly stale. Removed.
- The "runs in bootstrap mode" claim is **correct**, now verified rather than inferred:
  the test passes no `mode`, `selectStrandMode(undefined, hasOtherPeers=false)` returns
  `bootstrap`, and the log line now prints the real `StrandInstance.mode` — observed
  `alice=bootstrap bob=bootstrap`. Deliberately logged, not asserted: `mode` is read-only
  reporting, and pinning it here would make an RBAC test fail on a cohort-seeding change.
- The comment now points at the closed-strand physical proof for a strand that does replicate.

**`docs/cadre-consistency.md`** — one paragraph in *What Ships Today* recording the strand
measurement and the control-vs-strand backfill asymmetry.

## Validation actually run

| command | result |
| --- | --- |
| `yarn vitest run src/scenarios/strand-membership-closed-strand-e2e.integration.ts` | **4 passed** (3 pre-existing unchanged + the new one) |
| `yarn vitest run src/scenarios/rbac-signed-write.integration.ts` | **1 passed** |
| `yarn typecheck` (in `packages/integration-tests`) | exit 0 |
| `yarn lint` (repo root, fully-enforced gate) | exit 0 |

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

## Use cases the reviewer should exercise

- **Re-run the closed-strand file.** All four must pass. The physical test's log line is the
  measurement of record: `founder holds 27 committed blocks, 13 of them authored or
  advanced since the dial; joiner's own store covered those in 1ms`.
- **Try to break the narrowing.** Drop the `include` option from the coverage call and the
  test must fail naming ~9 pre-dial block ids — that is the property this ticket
  deliberately does NOT claim. Confirms the narrowing is load-bearing, not decorative.
- **Try to make it vacuous.** Give both nodes the same `captureRawStorage()` (floor A
  catches it), or move the baseline snapshot to after the writes (the `authored.size >= 6`
  floor catches it).
- **`compareBlockCoverage` without options** must behave exactly as before — it is still
  called that way nowhere in the suite, so the default path has no live caller. See gaps.

## Known gaps — treat these as the starting point

- **The `include` default path has no test coverage.** `compareBlockCoverage`'s two-argument
  form is now unused by any scenario; only the narrowed three-argument form runs. There are
  no unit tests for `block-store-probe.ts` at all — every one of its guard clauses
  (`listBlockIds` missing, scope collapse, unknown strand, `metadataOnly`, `behind`) is
  reasoned-about but unexercised. `behind` and `metadataOnly` have never been observed
  non-empty in a real run.
- **Single-run measurements.** The numbers in the comments (18 / 27 / 13 / 1 ms) come from
  one machine, one run each, in-memory storage. The `>= 6` floor was chosen as roughly half
  the observed 13; it has not been stress-tested against a slower box or a different
  storage backend. If it ever proves flaky the honest fix is to lower the floor, not to
  widen the timeout.
- **The 1 ms convergence means the poll never actually polled.** Coverage was complete on
  the first iteration, so the `GATE` budget in this test has never been exercised as a
  wait. A regression that made replication merely *slow* rather than absent would still
  pass, and nothing here distinguishes those.
- **Two of the nine never-arriving blocks are node-local roots.** They are described in the
  test comment as "different block id on each node, by construction" — that is inference
  from the diagnostic output (founder `myyCIg…@9`/`nfb5jZ…@9` vs joiner `0nQWkp…@9`/
  `r45NoX…@9`, same revision, different ids), not something traced to the code that mints
  them. If a reviewer wants that nailed down, it is a short read of optimystic's
  block-naming, and it changes nothing about the assertion either way.
- **The probe module's confound warning is stated more strongly than measured.** It says a
  read through a node "can" pull a block into that node's store. In this run the visibility
  tests read `joinerDb` repeatedly and the pre-dial blocks stayed absent — so that path did
  not fire here. The warning is still correct as a caution and the `joinerDb`-is-off-limits
  rule in the test is still the right discipline, but nobody has demonstrated the confound.
- **Nothing was run beyond these two scenario files.** The harness change is additive (a new
  optional parameter, a new export), so cross-suite risk is low, but the rest of the
  integration suite was not executed in this pass.
