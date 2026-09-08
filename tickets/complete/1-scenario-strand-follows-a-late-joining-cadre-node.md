----
description: An integration test now proves that a workspace created on one machine really arrives on a second machine added to the account later, and still opens there when that machine is on its own.
files: packages/integration-tests/src/scenarios/strand-late-cadre-join.integration.ts, packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/harness/block-store-probe.ts, packages/integration-tests/src/scenarios/control-offline-read-after-restart.integration.ts, docs/cadre-consistency.md
----

# Landed: a machine that joins the cadre after a strand exists receives that strand

## What shipped

**`packages/integration-tests/src/scenarios/strand-late-cadre-join.integration.ts`** — two tests
over one local bring-up:

- **Test 1.** A founder alone (own owner, storage profile) creates an open strand, publishes it,
  and writes five rows with zero control connections asserted at that instant. Its pre-join strand
  block index is snapshotted. A newcomer is then enrolled through the production membership path
  (vouch before start, `createSeed`/`applySeed`, pinned owner key, membership asserted both ways),
  discovers the strand from its own watcher's `strand:discovered` event, and joins with that row.
  The strand mesh forms from the strand-address RPC seed alone — no test-side dial — and is
  asserted in both directions with the founder's strand peer id proven distinct from its control
  peer id. The physical claim is then read off **raw stores only**: full coverage of the founder's
  store, then every pre-join block id named individually. Finally the founder stops and the
  newcomer reads all five rows at zero strand connections, and the newcomer is cold-restarted on
  the same storage and key, alone, where `queryStrands()` still names the strand and all five rows
  read back again.
- **Test 2.** The boundary: a cadre machine that sees the strand and never runs it is handed no
  strand-scoped store at all, runs no instance, and emits no start or error events — with the
  founder's own store asserted non-empty so the absence means something.

**`harness/node-fixtures.ts`** — `ControlNodeOpts.storageProvider`, forwarded verbatim as
`storage.provider`, throwing when combined with `storageOpDelayMs`. Default path unchanged.

**`harness/block-store-probe.ts`** (added in review) — `awaitBlockCoverage`, the coverage poll that
carries the last observed gap into its timeout message.

## Review findings

Read the implement diff first, then the harness and the neighbouring scenarios it stands on.

### Fixed in this pass (minor)

- **Duplicated coverage-poll loop.** The new file wrote a local `awaitCoverage` that reproduced,
  almost line for line, the `waitUntil`-around-`compareBlockCoverage` block already inline in
  `control-offline-read-after-restart.integration.ts` — and `scenario-strand-writes-straddle-a-late-join`
  is queued to need a third copy. Hoisted into `harness/block-store-probe.ts` as `awaitBlockCoverage`
  (with the `include` narrowing passed through, so a narrowed wait does not have to re-copy it) and
  both call sites moved onto it.
- **A fifth private node-config builder, now removable.** `control-offline-read-after-restart.integration.ts`
  carried its own `nodeOn(...)` hand-written `CadreNodeConfig` literal, whose only difference from
  the shared `controlNodeConfig` was the caller-supplied storage provider — exactly the seam this
  ticket added. Folded onto the shared helper and re-ran that file green. The consolidation ticket
  `harness-one-node-config-builder` did not know about this copy; an arm recording that (and that
  its "accepts a caller-supplied storage provider" item is already done) is appended there.
- **Teardown could abandon nodes.** `stopLateJoin` used `node?.stop().catch(...)`, which does not
  catch a `stop()` that throws synchronously — such a throw would escape the loop and leave every
  later node in the list running as a leaked libp2p node. Converted to try/catch, matching
  `stopStartedNodes` in the harness.
- **Docs did not reflect the new coverage.** `docs/cadre-consistency.md` named the closed-strand
  e2e as the strand-side measurement of the peer-join block catch-up and stopped there. Added the
  late-cadre-join property and its negative-case boundary alongside it. `docs/architecture.md`,
  `docs/strands.md` and `docs/testing.md` were read and need no change: none of them carries a
  scenario inventory, and none makes a claim this work contradicts.
- **One inaccurate comment.** The schema constant claimed "two other strand scenarios"; five other
  scenario files use that one-table sApp. Reworded.

### Recorded as a tripwire, not a ticket

- **Phase 4b's `queryStrands()` read is not gated on the control-network catch-up.** It relies on
  the Strand row's blocks reaching the newcomer's control store during the several seconds of
  Phases 2-4a (one ~1 s debounce), which has held on every run to date. Gating it would mean a new
  30 s coverage wait on the whole control store — a flake risk of its own, for a failure never
  observed. Parked as a `NOTE:` at the exact site, naming the fix (an `awaitBlockCoverage` on the
  two control-scope stores *before* `newcomer.stop()`) and the trap to avoid (never gate it by
  reading through the restarted node, which would pull the row in and mask the gap).

### Checked and deliberately not filed

- **No direct strand-address RPC pre-check before the mesh wait.** A responder-side RPC failure and
  a discovery failure both surface as the same Phase 2 timeout. That is diagnosability, not a
  missing assertion — the test still fails, just less specifically — and the file header already
  tells a future debugger to add the probe `strand-addr-seed-convergence` uses.
- **Test 1 does not pin exact lifecycle-event arrays.** It asserts the started instance via
  `status === 'active'` and the discovered row by equality, so a spurious extra event would pass
  unnoticed in Test 1 (Test 2 does assert `started` and `errors` empty). No mechanism is known that
  would emit one, and pinning arrays on the positive test would couple it to watcher internals it
  is not about.
- **The per-block-id loop in Phase 3 is redundant given the coverage wait before it** — block ids
  never disappear from the founder's store, so complete coverage already implies every pre-join id
  is present. Kept anyway: it is what logs the "written before you existed" id list, which is the
  evidence a future reader actually wants, and it costs one index read.
- **`collectStrandEvents` is duplicated with `strand-unpublish-sibling-convergence`.** Explicitly
  sanctioned by the plan ticket, which reserves the hoist for `harness-topology-builder`.
- **`LateJoinFixture` returns two fields neither test reads** (`founderCapture`, `newcomerPeerId`),
  and `StrandEvents.stopped` is collected but never asserted. Left in place: the queued
  `scenario-strand-writes-straddle-a-late-join` splits this bring-up in two and is the natural
  point to decide what the seam should expose.
- **No accepted-tradeoff `NOTE:` exists at any site touched here**, so nothing was re-filed against
  a decision a human had already made.

### Not found

- No correctness defect in the scenario's assertions, no vacuous assertion, and no ordering that
  would let a test pass without the property holding. The three load-bearing guards — the newcomer
  constructed only after the writes, zero founder control connections measured at that instant, and
  raw stores only in Phase 3 — are all present, and each is asserted rather than narrated.
- No resource leak: every node reaches `stopLateJoin` through a `finally`, including one that fails
  part-way through bring-up.
- No new ticket was warranted. Nothing found rose above the minor bar, so nothing was filed — this
  is an empty category with a reason, not an omission.

## Validation

- `yarn lint` — exit 0. `yarn workspace @serfab/integration-tests typecheck` — exit 0. Both re-run
  after the review's edits.
- `yarn workspace @serfab/integration-tests test src/scenarios/strand-late-cadre-join.integration.ts src/scenarios/control-offline-read-after-restart.integration.ts`
  — **3 review runs, all green**, on top of the implementer's 6, so 9 clean runs of the new file in
  total. The founder's pre-join strand store held **6 committed blocks on every run**
  (`optimystic/schema`, `default/Data`, four hash-named blocks); the anti-vacuity floor stays pinned
  at 4. Roughly 31-41 s per run. Logs: `tickets/.logs/review-late-cadre-join.run{1,2,3}.log`.
- The other neighbouring strand scenarios were not re-run in review: the harness edit is a pure
  addition (`awaitBlockCoverage`) that no other file imports, and the pre-existing symbols beside it
  are unchanged — typecheck and lint cover that reach.
- `bug-strand-join-dies-on-missing-block` did not reproduce in any review run either (9 clean joins
  against its roughly 1-in-9 rate is unremarkable, not evidence the bug is gone). No pre-existing
  failure was encountered, so `tickets/.pre-existing-error.md` was not written.

## Follow-on work already on the board

`scenario-strand-writes-straddle-a-late-join` (implement, seq 1.5) extends this file with the
concurrent-writer case and splits the bring-up. `harness-one-node-config-builder` (plan, seq 2)
carries the review's arm about the fifth builder and the already-landed storage-provider option.
